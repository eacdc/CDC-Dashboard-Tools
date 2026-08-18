// CDC Dashboard API — ingest Tally JSON into MongoDB and serve it back to the
// dashboards by date range. Also serves the static dashboards so the whole thing
// can run as a single Render web service.
// Auto-deploy test marker — 2026-07-24 (server/ change, expected to trigger a Render deploy).
require('./loadEnv');
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { getDb, close } = require('./db');
const { ingest, getSyncState, syncIncremental } = require('./ingest');

const PORT = process.env.PORT || 3000;
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const REPO_ROOT = path.join(__dirname, '..');

const app = express();
// gzip every response. The dataset JSON (~2 MB of vouchers) compresses ~8-10x,
// so this is the single biggest win for the dashboard's initial load time.
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '64mb' })); // full-FY voucher payloads are a few MB

// ---- helpers ----------------------------------------------------------------
function currentFyStart(today) {
  // Indian FY starts 1 April. Returns yyyyMMdd for 1-Apr of the current FY.
  const y = today.getFullYear();
  const m = today.getMonth() + 1; // 1..12
  const fyYear = m >= 4 ? y : y - 1;
  return `${fyYear}0401`;
}
function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function isYmd(s) { return typeof s === 'string' && /^\d{8}$/.test(s); }

// ---- health -----------------------------------------------------------------
app.get('/health', async (_req, res) => {
  try { await getDb(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- ingest -----------------------------------------------------------------
app.post('/ingest', async (req, res) => {
  if (INGEST_TOKEN && req.get('x-ingest-token') !== INGEST_TOKEN) {
    return res.status(401).json({ error: 'bad or missing x-ingest-token' });
  }
  try {
    const result = await ingest(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// ---- incremental sync (ALTERID) --------------------------------------------
// The extractor asks how far we've synced, pulls only what changed, and posts back.
app.get('/api/sync-state', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase();
    if (!['kol', 'ahm'].includes(branch)) return res.status(400).json({ error: 'branch must be kol|ahm' });
    res.json(await getSyncState(branch));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/sync', async (req, res) => {
  if (INGEST_TOKEN && req.get('x-ingest-token') !== INGEST_TOKEN) {
    return res.status(401).json({ error: 'bad or missing x-ingest-token' });
  }
  try {
    res.json({ ok: true, ...(await syncIncremental(req.body || {})) });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

// ---- query: dataset by date range ------------------------------------------
// GET /api/dataset?from=YYYYMMDD&to=YYYYMMDD&branch=all|kol|ahm
// Returns per-branch hierarchy + vouchers, ready for the dashboard pipeline.
app.get('/api/dataset', async (req, res) => {
  try {
    const today = new Date();
    const from = isYmd(req.query.from) ? req.query.from : currentFyStart(today);
    const to = isYmd(req.query.to) ? req.query.to : ymd(today);
    const wantBranch = ['kol', 'ahm', 'all'].includes(req.query.branch) ? req.query.branch : 'all';
    const branches = wantBranch === 'all' ? ['kol', 'ahm'] : [wantBranch];

    const db = await getDb();
    const out = { from, to, branches: {} };
    for (const branch of branches) {
      const master = await db.collection('masters').findOne({ branch }, { projection: { _id: 0 } });
      // "Last updated" = the most recent write we know about for this branch: the
      // master snapshot (pushed every sync) or the incremental sync high-water stamp.
      const syncSt = await db.collection('sync_state').findOne({ branch }, { projection: { updatedAt: 1 } });
      const stamps = [master && master.updatedAt, syncSt && syncSt.updatedAt]
        .filter(Boolean).map((d) => new Date(d).getTime());
      const lastUpdatedAt = stamps.length ? new Date(Math.max.apply(null, stamps)).toISOString() : null;
      const vouchers = await db.collection('vouchers')
        .find({ branch, date: { $gte: from, $lte: to } },
              // `details` is excluded here to keep the dashboard payload small — the
              // dashboards only need the ledger amounts. Fetch the full voucher
              // (with details) on demand via /api/voucher for the printable view.
              // `guid` IS kept: it's the only unambiguous voucher id (Tally reuses
              // voucher numbers each FY), so the drill-down's View/PDF link uses it.
              { projection: { _id: 0, branch: 0, updatedAt: 0, details: 0 } })
        .sort({ date: 1 })
        .toArray();
      out.branches[branch] = {
        hierarchy: master ? { ledgers: master.ledgers, groups: master.groups, ids: master.ids || {} } : null,
        vouchers,
        lastUpdatedAt,
      };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- single voucher (full detail, for the printable invoice/journal PDF) ----
// GET /api/voucher?branch=kol|ahm&id=<guid|_id>   OR   ?branch=&no=<vchNo>&type=<vchType>&date=<YYYYMMDD>
// Returns the complete stored voucher including `details` (party GSTIN/address,
// invoice metadata, e-way bill, narration, and stock-item lines).
app.get('/api/voucher', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase();
    if (!['kol', 'ahm'].includes(branch)) return res.status(400).json({ error: 'branch must be kol|ahm' });
    const db = await getDb();
    const proj = { projection: { branch: 0, updatedAt: 0 } };
    let doc = null;
    if (req.query.id) {
      const id = String(req.query.id);
      doc = await db.collection('vouchers').findOne({ branch, $or: [{ _id: id }, { guid: id }, { _id: `${branch}:${id}` }] }, proj);
    } else if (req.query.no) {
      const q = { branch, no: String(req.query.no) };
      if (req.query.type) q.type = String(req.query.type);
      if (isYmd(req.query.date)) q.date = String(req.query.date);
      doc = await db.collection('vouchers').findOne(q, proj);
    } else {
      return res.status(400).json({ error: 'provide id, or no (+ optional type/date)' });
    }
    if (!doc) return res.status(404).json({ error: 'voucher not found' });
    // Enrich the Bill-to contact block from the party's Ledger master (contact
    // person/email/mobile are stored on the ledger, not the voucher). Only fills
    // gaps, so anything already on the voucher wins.
    if (doc.details) {
      const master = await db.collection('masters').findOne({ branch }, { projection: { contacts: 1 } });
      const contacts = master && master.contacts;
      if (contacts) {
        const key = doc.party || doc.details.partyMailName || doc.details.partyName;
        const c = key && contacts[key];
        if (c) {
          if (!doc.details.contactName && c.name) doc.details.contactName = c.name;
          if (!doc.details.contactEmail && c.email) doc.details.contactEmail = c.email;
          if (!doc.details.contactMobile && c.mobile) doc.details.contactMobile = c.mobile;
        }
      }
    }
    res.json(doc);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- meta: coverage ---------------------------------------------------------
app.get('/api/meta', async (_req, res) => {
  try {
    const db = await getDb();
    const meta = {};
    for (const branch of ['kol', 'ahm']) {
      const count = await db.collection('vouchers').countDocuments({ branch });
      const min = await db.collection('vouchers').find({ branch }).sort({ date: 1 }).limit(1).toArray();
      const max = await db.collection('vouchers').find({ branch }).sort({ date: -1 }).limit(1).toArray();
      const master = await db.collection('masters').findOne({ branch }, { projection: { updatedAt: 1 } });
      meta[branch] = {
        vouchers: count,
        firstDate: min[0] ? min[0].date : null,
        lastDate: max[0] ? max[0].date : null,
        masterUpdatedAt: master ? master.updatedAt : null,
      };
    }
    res.json(meta);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- projection overrides (shared across everyone) --------------------------
// The Projected view lets users override per-party collection/payment days and
// exclude parties. These used to live in each browser's localStorage; now they
// live in one shared Mongo doc so every user sees the same numbers.
//   GET  /api/overrides            -> { daysOverrides, excluded, excludedBills, writeOffs, updatedAt }
//   POST /api/overrides { daysOverrides, excluded, excludedBills, writeOffs }  (full replace; upsert)
// excludedBills drops a SINGLE unpaid bill from the projection (keyed
// party|ref|date|amt), where `excluded` drops the whole party.
// writeOffs marks a bill as never collectable/payable (bad debt, or a phantom
// left by a name mismatch): it leaves receivables/payables as well as the
// projection. Value is the reason string, so the write-off list stays auditable.
app.get('/api/overrides', async (_req, res) => {
  try {
    const db = await getDb();
    const doc = await db.collection('overrides').findOne({ _id: 'pcf' }, { projection: { _id: 0 } });
    res.json(doc || { daysOverrides: {}, excluded: {}, excludedBills: {}, writeOffs: {}, updatedAt: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/overrides', async (req, res) => {
  try {
    const b = req.body || {};
    const daysOverrides = (b.daysOverrides && typeof b.daysOverrides === 'object') ? b.daysOverrides : {};
    const excluded = (b.excluded && typeof b.excluded === 'object') ? b.excluded : {};
    const excludedBills = (b.excludedBills && typeof b.excludedBills === 'object') ? b.excludedBills : {};
    const writeOffs = (b.writeOffs && typeof b.writeOffs === 'object') ? b.writeOffs : {};
    const db = await getDb();
    const updatedAt = new Date();
    await db.collection('overrides').updateOne(
      { _id: 'pcf' },
      { $set: { daysOverrides, excluded, excludedBills, writeOffs, updatedAt } },
      { upsert: true }
    );
    res.json({ ok: true, updatedAt: updatedAt.toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- party aliases (shared name-merge map) ---------------------------------
// Maps a variant/old ledger name to its canonical (current) name, so a party
// renamed in Tally is merged everywhere. One shared Mongo doc, editable from the UI.
//   GET  /api/aliases          -> { map: {variant: canonical}, updatedAt }
//   POST /api/aliases { map }   (full replace; upsert)
app.get('/api/aliases', async (_req, res) => {
  try {
    const db = await getDb();
    const doc = await db.collection('aliases').findOne({ _id: 'party' }, { projection: { _id: 0 } });
    res.json(doc || { map: {}, updatedAt: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/aliases', async (req, res) => {
  try {
    const b = req.body || {};
    const map = (b.map && typeof b.map === 'object') ? b.map : {};
    const db = await getDb();
    const updatedAt = new Date();
    await db.collection('aliases').updateOne({ _id: 'party' }, { $set: { map, updatedAt } }, { upsert: true });
    res.json({ ok: true, updatedAt: updatedAt.toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- shared input files (bill-wise CSVs + stock template) ------------------
// These change rarely (opening bills once a year; stock ~monthly). Store them
// once in Mongo so every user shares the same inputs instead of each browser
// caching its own. Keys: kolBillsRecv, kolBillsPay, ahmBillsPay, stock.
//   GET  /api/files            -> { kolBillsRecv, kolBillsPay, ahmBillsPay, stock, updatedAt }
//   POST /api/files { key, content }   (upsert one file; content=null clears it)
var FILE_KEYS = new Set(['kolBillsRecv', 'kolBillsPay', 'ahmBillsPay', 'stock']);
app.get('/api/files', async (_req, res) => {
  try {
    const db = await getDb();
    const doc = await db.collection('inputfiles').findOne({ _id: 'inputs' }, { projection: { _id: 0 } });
    res.json(doc || {});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/files', async (req, res) => {
  try {
    const b = req.body || {};
    const key = String(b.key || '');
    if (!FILE_KEYS.has(key)) return res.status(400).json({ error: 'key must be one of kolBillsRecv|kolBillsPay|ahmBillsPay|stock' });
    const content = (b.content == null) ? null : String(b.content);
    const db = await getDb();
    const updatedAt = new Date();
    await db.collection('inputfiles').updateOne({ _id: 'inputs' }, { $set: { [key]: content, [key + 'UpdatedAt']: updatedAt, updatedAt } }, { upsert: true });
    res.json({ ok: true, key, updatedAt: updatedAt.toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- static dashboards ------------------------------------------------------
// Served from the repo root so /consolidated, /projected, /dashboard work.
app.use('/consolidated', express.static(path.join(REPO_ROOT, 'consolidated')));
app.use('/projected', express.static(path.join(REPO_ROOT, 'projected')));
app.use('/dashboard', express.static(path.join(REPO_ROOT, 'dashboard')));
app.use('/portal', express.static(path.join(REPO_ROOT, 'portal')));
app.use('/voucher', express.static(path.join(REPO_ROOT, 'voucher')));
// Root opens the portal (the primary UI). The other pages stay reachable at
// their own paths (/consolidated, /projected, /dashboard) and the API at /api/*.
app.get('/', (_req, res) => res.redirect('/portal/'));

const server = app.listen(PORT, () => console.log(`CDC API listening on :${PORT}`));

// ---- keep-alive (Render free tier sleeps after ~15 min idle) ----------------
// Opt-in with KEEP_ALIVE=true. Pings our own PUBLIC url every 14 min so Render's
// router sees inbound traffic and never idles the service. Uses Render's
// auto-provided RENDER_EXTERNAL_URL; pinging localhost would NOT count.
if (process.env.KEEP_ALIVE === 'true' || process.env.KEEP_ALIVE === '1') {
  const selfUrl = (process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
  const EVERY = 14 * 60 * 1000;
  setInterval(() => {
    fetch(`${selfUrl}/health`).then((r) => console.log(`keep-alive ping ${r.status}`)).catch((e) => console.log('keep-alive failed:', e.message));
  }, EVERY).unref();
  console.log(`keep-alive on: pinging ${selfUrl}/health every 14 min`);
}

process.on('SIGTERM', async () => { await close(); server.close(); });
process.on('SIGINT', async () => { await close(); server.close(); process.exit(0); });

module.exports = app;
