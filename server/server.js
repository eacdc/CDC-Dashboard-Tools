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
const { ingest, resetBranch, getSyncState, syncIncremental, readMaster } = require('./ingest');
const { suggestAliases, newProfiles, addVoucher, finalizeProfiles } = require('./aliasSuggest');
const yoy = require('./yoySummary');
const E = require('./plEngine');

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

// Which financial years does this ingest/sync payload touch? Used to refresh only
// those years of the year-on-year summary. Endpoints alone are not enough -- a
// back-fill range spans the years between them too. An empty result means "cannot
// tell", and nothing is refreshed rather than everything.
function fysTouched(body) {
  const dates = [];
  if (body && isYmd(body.from)) dates.push(body.from);
  if (body && isYmd(body.to)) dates.push(body.to);
  for (const d of (body && body.changedDates) || []) if (isYmd(String(d))) dates.push(String(d));
  for (const v of (body && body.vouchers) || []) if (v && isYmd(String(v.date))) dates.push(String(v.date));
  if (!dates.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const d of dates) { const f = yoy.fyOf(d); if (f < lo) lo = f; if (f > hi) hi = f; }
  const out = [];
  for (let y = lo; y <= hi && out.length < 30; y++) out.push(yoy.fyLabel(y));
  return out;
}

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
    // Keep the year-on-year summary honest without anyone asking: rebuild only the
    // financial years this push touched. A daily sync touches one, so it costs one.
    requestYoy(fysTouched(req.body));
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// ---- reset a branch before a clean re-ingest --------------------------------
// POST /admin/reset { branch, from, to }   -> delete that branch's vouchers in the range
// POST /admin/reset { branch, all: true }  -> delete every voucher of that branch
// Also drops the branch's master and sync_state unless master:false / syncState:false.
// For when the wrong Tally company was pulled into a branch: those vouchers have
// foreign GUIDs, so nothing but a delete removes them (see resetBranch).
// Token-protected like /ingest, and the scope must be stated explicitly.
app.post('/admin/reset', async (req, res) => {
  if (INGEST_TOKEN && req.get('x-ingest-token') !== INGEST_TOKEN) {
    return res.status(401).json({ error: 'bad or missing x-ingest-token' });
  }
  try {
    res.json({ ok: true, ...(await resetBranch(req.body || {})) });
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
    const out = await syncIncremental(req.body || {});
    requestYoy(fysTouched(req.body));
    res.json({ ok: true, ...out });
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
      // readMaster unions in ledgers/groups that only ever existed in a back-filled
      // older financial year, so historical vouchers still classify. Live wins.
      const hier = readMaster(master);
      out.branches[branch] = {
        hierarchy: hier ? { ledgers: hier.ledgers, groups: hier.groups, ids: hier.ids } : null,
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
      const master = await db.collection('masters').findOne({ branch }, { projection: { contacts: 1, histContacts: 1 } });
      const contacts = master && readMaster(master).contacts;
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
// GET /api/meta                                   -> whole-collection counts per branch
// GET /api/meta?from=20250401[&to=20260331]       -> adds a `window` block per branch
// GET /api/meta?from=...&byMonth=1                -> adds months: { '202504': n, ... }
// GET /api/meta?from=...&byDay=1                  -> adds days:   { '20250401': n, ... }
//
// The window is what tells you whether a pull actually landed: a month or a day
// that reads 0 (or far below its neighbours) is a gap to re-pull, not a quiet month.
const DATE8 = /^\d{8}$/;
app.get('/api/meta', async (req, res) => {
  try {
    const q = req.query || {};
    const from = DATE8.test(String(q.from || '')) ? String(q.from) : null;
    const to = DATE8.test(String(q.to || '')) ? String(q.to) : null;
    const byMonth = q.byMonth === '1' || q.byMonth === 'true';
    const byDay = q.byDay === '1' || q.byDay === 'true';
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    const hasRange = from || to;

    const db = await getDb();
    const meta = {};
    for (const branch of ['kol', 'ahm']) {
      const count = await db.collection('vouchers').countDocuments({ branch });
      const min = await db.collection('vouchers').find({ branch }).sort({ date: 1 }).limit(1).toArray();
      const max = await db.collection('vouchers').find({ branch }).sort({ date: -1 }).limit(1).toArray();
      const master = await db.collection('masters').findOne({ branch }, { projection: { updatedAt: 1 } });
      const row = {
        vouchers: count,
        firstDate: min[0] ? min[0].date : null,
        lastDate: max[0] ? max[0].date : null,
        masterUpdatedAt: master ? master.updatedAt : null,
      };
      if (hasRange) {
        const sel = { branch, date: range };
        const wMin = await db.collection('vouchers').find(sel).sort({ date: 1 }).limit(1).toArray();
        const wMax = await db.collection('vouchers').find(sel).sort({ date: -1 }).limit(1).toArray();
        row.window = {
          from: from || null,
          to: to || null,
          vouchers: await db.collection('vouchers').countDocuments(sel),
          firstDate: wMin[0] ? wMin[0].date : null,
          lastDate: wMax[0] ? wMax[0].date : null,
        };
      }
      if (byMonth || byDay) {
        const sel = hasRange ? { branch, date: range } : { branch };
        const key = byDay ? '$date' : { $substrBytes: ['$date', 0, 6] };
        const rows = await db.collection('vouchers').aggregate([
          { $match: sel },
          { $group: { _id: key, n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]).toArray();
        const bag = {};
        for (const r of rows) bag[r._id] = r.n;
        row[byDay ? 'days' : 'months'] = bag;
      }
      meta[branch] = row;
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
    const set = { map, updatedAt };
    // Pairs a person has looked at and rejected. Kept so /api/alias-suggestions
    // stops offering them -- a suggestion that comes back every session is worse
    // than no suggestion. Omitted here = leave whatever is stored alone.
    if (Array.isArray(b.dismissed)) set.dismissed = b.dismissed.map(String).slice(0, 5000);
    await db.collection('aliases').updateOne({ _id: 'party' }, { $set: set }, { upsert: true });
    // Merging two names changes which party every year's figures belong to, so the
    // stored summary is now wrong for all of them, not just the current one.
    // Rebuilt in the background; it coalesces, so saving twice costs one pass.
    requestYoy(null);
    res.json({ ok: true, updatedAt: updatedAt.toISOString(), rebuilding: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- suggested party merges ------------------------------------------------
// Finds ledgers that are the same party under two names -- chiefly a party renamed
// between financial years, which arrives as two unrelated ledgers.
//
// The scan reads EVERY voucher, not the range the browser has loaded: the old name
// usually lives in a year nobody has open. That is well over a hundred thousand
// documents once the back-fill years are in, and doing it inside the request is how
// the first version of this died -- Render's proxy gave up waiting and returned 502
// to the browser while the scan was still going.
//
// So it is not a request any more. POST starts it and returns immediately; the
// result is written to the alias_scan doc; GET serves whatever was last computed.
// A scan therefore survives the browser closing, and every later open is instant.
//
//   POST /api/alias-suggestions/scan[?branch=all|kol|ahm]  -> {started|running}
//   GET  /api/alias-suggestions[?limit=200]                -> {suggestions, running, updatedAt, ...}
//
// Applying a merge is still a person clicking Accept in the Merge-names dialog.
let aliasScan = { running: false, startedAt: null, branch: null, progress: 0, lastProgressAt: 0 };
// A scan is dead, not slow, when it stops making progress -- the process was
// recycled mid-scan (Render restarts freely) and nothing will ever clear the flag.
// Measured from the last voucher counted, NOT from the start: with a decade of
// history the scan legitimately runs for minutes, and timing out a healthy scan
// would let a second one start alongside it, doubling the load on Atlas.
const SCAN_STALE_MS = 10 * 60 * 1000;
function scanRunning() {
  if (!aliasScan.running) return false;
  const since = aliasScan.lastProgressAt || aliasScan.startedAt || 0;
  if (Date.now() - since > SCAN_STALE_MS) { aliasScan = { running: false, startedAt: null, branch: null, progress: 0, lastProgressAt: 0 }; return false; }
  return true;
}

async function runAliasScan(branch) {
  const db = await getDb();
  const q = branch === 'all' ? {} : { branch };
  // Stream the cursor: fold each voucher into the profiles and let it go. The
  // profiles stay a few thousand small objects however many vouchers there are.
  const profiles = newProfiles();
  let scannedVouchers = 0;
  const cursor = db.collection('vouchers')
    .find(q, { projection: { _id: 0, date: 1, party_ledgers: 1, 'details.partyGstin': 1, 'bills.ledger': 1, 'bills.ref': 1 } })
    .batchSize(1000);
  for await (const v of cursor) {
    addVoucher(profiles, v);
    // Report progress as we go: over a decade of history this runs for minutes, and
    // the dialog can say "212,000 vouchers so far" instead of an unmoving spinner.
    // It is also the heartbeat scanRunning() uses to tell a slow scan from a dead one.
    if (++scannedVouchers % 5000 === 0) { aliasScan.progress = scannedVouchers; aliasScan.lastProgressAt = Date.now(); }
  }
  aliasScan.progress = scannedVouchers; aliasScan.lastProgressAt = Date.now();
  finalizeProfiles(profiles);
  // Contacts and groups come from the branch masters (hist included: an old party's
  // group only exists in the back-filled half).
  const contacts = {}, groups = {};
  for (const b of branch === 'all' ? ['kol', 'ahm'] : [branch]) {
    const m = readMaster(await db.collection('masters').findOne({ branch: b }));
    if (!m) continue;
    for (const [k, v] of Object.entries(m.contacts || {})) contacts[k] = v;
    for (const [k, v] of Object.entries(m.ledgers || {})) groups[k] = v;
  }
  // Scored WITHOUT the alias map: pairs already merged or dismissed are filtered on
  // read instead, so accepting one suggestion does not invalidate the whole scan.
  const out = suggestAliases({ profiles, contacts, groups, limit: 1000 });
  await db.collection('alias_scan').updateOne({ _id: 'party' }, { $set: {
    branch, suggestions: out.suggestions, scanned: out.scanned, total: out.total,
    scannedVouchers, updatedAt: new Date(),
  } }, { upsert: true });
  return out;
}

app.post('/api/alias-suggestions/scan', async (req, res) => {
  try {
    const branch = String(req.query.branch || 'all').toLowerCase();
    if (!['all', 'kol', 'ahm'].includes(branch)) return res.status(400).json({ error: 'branch must be all|kol|ahm' });
    if (scanRunning()) return res.json({ running: true, startedAt: new Date(aliasScan.startedAt).toISOString() });
    aliasScan = { running: true, startedAt: Date.now(), branch, progress: 0, lastProgressAt: Date.now() };
    // Deliberately not awaited: the response goes back now, the scan carries on.
    runAliasScan(branch)
      .catch((e) => { aliasScan.error = e.message; console.error('alias scan failed:', e.message); })
      .finally(() => { aliasScan.running = false; });
    res.json({ started: true, branch });
  } catch (e) {
    aliasScan.running = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/alias-suggestions', async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const db = await getDb();
    const doc = await db.collection('alias_scan').findOne({ _id: 'party' });
    const aliasDoc = await db.collection('aliases').findOne({ _id: 'party' });
    const map = (aliasDoc && aliasDoc.map) || {};
    const no = new Set((aliasDoc && aliasDoc.dismissed) || []);
    // Filter on read, so Accept and "Not same" take effect at once without a rescan.
    const live = ((doc && doc.suggestions) || []).filter((s) =>
      !no.has(s.key) && map[s.variant] !== s.canonical && map[s.canonical] !== s.variant &&
      !(map[s.variant] && map[s.variant] === map[s.canonical]));
    const running = scanRunning();
    res.json({
      running,
      progress: running ? aliasScan.progress : 0,
      error: aliasScan.error || null,
      updatedAt: doc ? doc.updatedAt : null,
      scanned: doc ? doc.scanned : 0,
      scannedVouchers: doc ? doc.scannedVouchers : 0,
      total: live.length,
      suggestions: live.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- year-on-year summary --------------------------------------------------
// The landing page shows every financial year side by side, and opens a year into
// its twelve months. A decade of vouchers cannot travel to a browser, so the totals
// are folded here (server/yoySummary.js -- which borrows the dashboard's own
// classification, see plEngine.js) and stored as a few thousand numbers. The page
// then loads the whole thing, month detail included, in one small request.
//
//   GET  /api/yoy                      -> { fys, branches, updatedAt, running, ... }
//   POST /api/yoy/scan[?fy=2019-20]    -> rebuild everything, or just those years
//
// Rebuilding is a background job for the same reason the alias scan is: reading
// every voucher takes minutes, and Render's proxy will not wait.
let yoyState = { running: false, progress: 0, lastProgressAt: 0, pending: null, error: null };
function yoyRunning() {
  if (!yoyState.running) return false;
  if (Date.now() - (yoyState.lastProgressAt || 0) > SCAN_STALE_MS) { yoyState.running = false; return false; }
  return true;
}

// fys: null = every year; otherwise only those FY labels, and only those are replaced
// in the stored summary. The daily sync touches one year, so it costs one year.
// The two companies' ledger tables as ONE, exactly as the dashboards merge them:
// the portal's own mergeHierarchies, Kolkata first. Built by hand here once, with
// Object.assign -- which is last-wins -- so a ledger NAME living in both companies
// under different groups was classified one way on the P&L tab and another in the
// year-on-year fold. A customer then sat directly under Sundry Debtors in one view
// and inside a salesperson's group in the other, which reads as a missing row.
async function mergedHierarchy(db) {
  const empty = { ledgers: {}, groups: {}, ids: {} };
  const of = async (b) => readMaster(await db.collection('masters').findOne({ branch: b })) || empty;
  return E.mergeHierarchies(await of('kol'), await of('ahm'));
}

// The shared name-merge map, as the dashboards read it. Chains are already
// flattened by the editor that writes it, so one lookup is enough.
async function readAliasMap(db) {
  const doc = await db.collection('aliases').findOne({ _id: 'party' });
  return (doc && doc.map && typeof doc.map === 'object') ? doc.map : {};
}

// Every name that now reads as `canonical`: the name itself, plus the old spellings
// merged into it. The fold stores a party under its canonical name, but the VOUCHERS
// still carry whatever was typed at the time -- so a drill-down that looked only for
// the canonical name found nothing for the years booked under the old one.
function aliasVariants(map, canonical) {
  const out = [canonical];
  for (const variant of Object.keys(map || {})) {
    if (map[variant] === canonical && variant !== canonical) out.push(variant);
  }
  return out;
}

// The party-anchored detail is far larger than the line detail -- every customer and
// every supplier, three measures each -- so one document per branch/section/measure
// would run at Mongo's 16MB ceiling on a decade of history. Each is stored as a run
// of chunk documents instead, `<key>#0`, `<key>#1`, ..., and read back as one map.
const PARTY_CHUNK = 1500;               // parties per document

async function writePartyChunks(db, key, ledgers, updatedAt) {
  const names = Object.keys(ledgers);
  const coll = db.collection('yoy_party');
  let i = 0, part = 0;
  do {
    const slice = {};
    for (const name of names.slice(i, i + PARTY_CHUNK)) slice[name] = ledgers[name];
    await coll.updateOne({ _id: key + '#' + part },
      { $set: { key, part, ledgers: slice, updatedAt } }, { upsert: true });
    i += PARTY_CHUNK; part++;
  } while (i < names.length);
  // A rebuild that shrank this section must not leave the tail of the old run behind.
  await coll.deleteMany({ key, part: { $gte: part } });
}

async function readPartyChunks(db, key) {
  const out = {};
  const docs = await db.collection('yoy_party').find({ key }).sort({ part: 1 }).toArray();
  for (const d of docs) Object.assign(out, d.ledgers || {});
  return out;
}

async function runYoySummary(fys) {
  const db = await getDb();
  const xd = await mergedHierarchy(db);
  const aliases = await readAliasMap(db);
  const q = {};
  if (fys && fys.length) {
    // FY labels -> the date window they span, so Mongo filters instead of us.
    const years = fys.map((f) => parseInt(String(f).slice(0, 4), 10)).filter((y) => y > 1900);
    if (years.length) q.date = { $gte: Math.min(...years) + '0401', $lte: (Math.max(...years) + 1) + '0331' };
  }
  const S = yoy.newSummary(xd, aliases);
  let n = 0;
  const cursor = db.collection('vouchers')
    .find(q, { projection: { _id: 0, branch: 1, date: 1, type: 1, ledgers: 1, party_ledgers: 1 } })
    .batchSize(1000);
  for await (const v of cursor) {
    yoy.addVoucher(S, v);
    if (++n % 5000 === 0) { yoyState.progress = n; yoyState.lastProgressAt = Date.now(); }
  }
  yoyState.progress = n; yoyState.lastProgressAt = Date.now();
  const fresh = yoy.finalize(S);

  const prev = (await db.collection('yoy_summary').findOne({ _id: 'summary' })) || { branches: {}, fys: [] };
  let branches, allFys;
  if (!fys || !fys.length) { branches = fresh.branches; allFys = fresh.fys; }
  else {
    // Partial: keep every other year exactly as it was, replace only these. A year
    // whose vouchers were all deleted must disappear, so the rebuilt years are
    // cleared first rather than merged over.
    branches = JSON.parse(JSON.stringify(prev.branches || {}));
    const touched = new Set(fys);
    for (const b of Object.keys(branches)) for (const f of Object.keys(branches[b])) if (touched.has(f)) delete branches[b][f];
    for (const b of Object.keys(fresh.branches)) {
      branches[b] = branches[b] || {};
      for (const f of Object.keys(fresh.branches[b])) branches[b][f] = fresh.branches[b][f];
    }
    const s = new Set();
    for (const b of Object.keys(branches)) for (const f of Object.keys(branches[b])) s.add(f);
    allFys = [...s].sort();
  }
  const updatedAt = new Date();
  await db.collection('yoy_summary').updateOne({ _id: 'summary' }, { $set: {
    fys: allFys, branches, scannedVouchers: n, scope: (fys && fys.length) ? fys : 'all', updatedAt,
  } }, { upsert: true });

  // The per-ledger detail behind each line, one document per branch+line so no single
  // one grows unbounded (cash flows are keyed by party, and there are thousands).
  const fresh2 = yoy.detailOf(S);
  for (const key of Object.keys(fresh2)) {
    let ledgers = fresh2[key];
    if (fys && fys.length) {
      const prevDoc = await db.collection('yoy_detail').findOne({ _id: key });
      ledgers = yoy.spliceDetail(prevDoc && prevDoc.ledgers, ledgers, fys);
    }
    await db.collection('yoy_detail').updateOne({ _id: key },
      { $set: { ledgers, updatedAt } }, { upsert: true });
  }

  // The same again for the party-anchored sections, spliced the same way so a
  // one-year rebuild leaves the other ten years of every customer untouched.
  const fresh3 = yoy.partyDetailOf(S);
  for (const key of Object.keys(fresh3)) {
    let ledgers = fresh3[key];
    if (fys && fys.length) ledgers = yoy.spliceDetail(await readPartyChunks(db, key), ledgers, fys);
    await writePartyChunks(db, key, ledgers, updatedAt);
  }
  treeCache.clear();
}

// Building a tree walks a few thousand ledgers -- fast, but not per request, and the
// same line gets opened by every viewer. Keyed by the summary's build time, so a
// rebuild invalidates it without anyone having to remember to.
const treeCache = new Map();

// Coalescing worker: a rebuild asked for while one is running is remembered and run
// straight after, so a backfill pushing several years never starts several scans.
function requestYoy(fys) {
  // An empty list means the caller could not work out which years changed; leave the
  // summary alone rather than rebuilding a decade on every push.
  if (Array.isArray(fys) && !fys.length) return;
  const want = (fys && fys.length) ? new Set(fys) : null;
  if (yoyRunning()) {
    if (!yoyState.pending) yoyState.pending = want ? new Set(want) : null;
    else if (want) for (const f of want) yoyState.pending.add(f);
    else yoyState.pending = null;      // a full rebuild subsumes any pending years
    yoyState.pendingAll = yoyState.pendingAll || !want;
    return;
  }
  yoyState = { running: true, progress: 0, lastProgressAt: Date.now(), pending: want ? new Set(want) : null, pendingAll: !want, error: null };
  (async () => {
    let next = want ? [...want] : null;
    for (let guard = 0; guard < 20; guard++) {
      yoyState.pending = null; yoyState.pendingAll = false;
      await runYoySummary(next);
      if (!yoyState.pending && !yoyState.pendingAll) break;
      next = yoyState.pendingAll ? null : [...yoyState.pending];
    }
  })().catch((e) => { yoyState.error = e.message; console.error('yoy summary failed:', e.message); })
      .finally(() => { yoyState.running = false; });
}

app.post('/api/yoy/scan', async (req, res) => {
  try {
    const fy = req.query.fy ? String(req.query.fy).split(',').map((s) => s.trim()).filter(Boolean) : null;
    requestYoy(fy);
    res.json({ started: true, scope: fy || 'all', running: yoyRunning() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/yoy', async (_req, res) => {
  try {
    const db = await getDb();
    const doc = await db.collection('yoy_summary').findOne({ _id: 'summary' }, { projection: { _id: 0 } });
    const running = yoyRunning();
    res.json(Object.assign({ fys: [], branches: {}, updatedAt: null }, doc || {}, {
      running, progress: running ? yoyState.progress : 0, error: yoyState.error || null,
    }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/yoy/tree?branch=all|kol|ahm&line=revenue|purchase|directExp|indirectExp|cashIn|cashOut
// The accounts under one line, as the nested group tree the P&L tab draws, covering
// every year at once. Fetched when a line is opened, not with the landing page: the
// cash lines alone carry thousands of parties, and most visits never open them.
app.get('/api/yoy/tree', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const line = String(req.query.line || '');
    if (!yoy.TREE_LINES.includes(line)) {
      return res.status(400).json({ ok: false, error: `unknown line "${line}"; expected one of ${yoy.TREE_LINES.join(', ')}` });
    }
    const db = await getDb();
    const summary = await db.collection('yoy_summary').findOne({ _id: 'summary' }, { projection: { fys: 1, updatedAt: 1 } });
    const fys = (summary && summary.fys) || [];
    if (!fys.length) return res.json({ fys: [], tree: [], updatedAt: null });
    const stamp = summary.updatedAt ? new Date(summary.updatedAt).getTime() : 0;
    const ck = branch + '|' + line + '|' + stamp;
    if (treeCache.has(ck)) return res.json(treeCache.get(ck));

    const xd = await mergedHierarchy(db);
    const want = branch === 'all' ? ['kol', 'ahm'] : [branch];
    const parts = [];
    for (const b of want) {
      const doc = await db.collection('yoy_detail').findOne({ _id: b + '|' + line });
      parts.push((doc && doc.ledgers) || {});
    }
    const out = { fys, line, branch, tree: yoy.treeFrom(parts, xd, fys), updatedAt: summary.updatedAt || null };
    treeCache.clear();               // one line at a time; the trees are large
    treeCache.set(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/yoy/party?branch=all|kol|ahm&section=sales|purchase&measure=netpl|net|gross
// The Sales Analysis page's own tree, year on year: every sale attributed to its
// Sundry-Debtor party (every purchase to its Sundry-Creditor one) and nested by that
// party's Tally groups, so it opens salesperson -> company -> party.
//
// `root` carries the section's own months, so the header total comes from the same
// fold the rows do rather than being re-added in the browser.
app.get('/api/yoy/party', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const section = String(req.query.section || 'sales');
    const measure = String(req.query.measure || 'netpl');
    if (!yoy.PARTY_SECTIONS[section]) {
      return res.status(400).json({ ok: false, error: `unknown section "${section}"; expected one of ${Object.keys(yoy.PARTY_SECTIONS).join(', ')}` });
    }
    if (!yoy.PARTY_MEASURES.includes(measure)) {
      return res.status(400).json({ ok: false, error: `unknown measure "${measure}"; expected one of ${yoy.PARTY_MEASURES.join(', ')}` });
    }
    const db = await getDb();
    const summary = await db.collection('yoy_summary').findOne({ _id: 'summary' }, { projection: { fys: 1, updatedAt: 1 } });
    const fys = (summary && summary.fys) || [];
    if (!fys.length) return res.json({ fys: [], root: {}, tree: [], updatedAt: null });
    const stamp = summary.updatedAt ? new Date(summary.updatedAt).getTime() : 0;
    const ck = 'party|' + branch + '|' + section + '|' + measure + '|' + stamp;
    if (treeCache.has(ck)) return res.json(treeCache.get(ck));

    const xd = await mergedHierarchy(db);
    const built = yoy.partyTreeFrom(await readPartyChunks(db, branch + '|' + section + '|' + measure), xd, fys, section);
    const out = { fys, branch, section, measure, root: built.root, tree: built.tree, updatedAt: summary.updatedAt || null };
    treeCache.clear();               // one section at a time; the trees are large
    treeCache.set(ck, out);
    res.json(out);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/bills/coverage
// Can the outstanding figure be computed from the VOUCHERS alone, and the uploaded
// Bills CSV retired? The pipeline has captured bill-wise allocations since August
// 2026, and a back-fill re-pull would have brought them for older years too -- but
// "would have" is not a measurement, and dropping the CSV on a guess would silently
// lose whatever it alone still carries. So this counts, and does not change anything:
//
//   * how far back the vouchers carry allocations, per branch, month by month;
//   * every bill the CSV still shows OPEN, and whether that same reference appears
//     in the vouchers' own allocations -- by reference, and by money.
//
// The answer that matters is `csv[file].missing`: bills the CSV alone knows about.
// Zero of them, and the file is redundant.
app.get('/api/bills/coverage', async (_req, res) => {
  try {
    const db = await getDb();
    const out = { ok: true, branches: {}, csv: {}, checkedAt: new Date().toISOString() };

    // 1. how far back do the vouchers carry bill allocations?
    const cov = await db.collection('vouchers').aggregate([
      { $group: {
        _id: { branch: '$branch', ym: { $substrBytes: ['$date', 0, 6] } },
        vouchers: { $sum: 1 },
        withBills: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$bills', []] } }, 0] }, 1, 0] } },
      } },
      { $sort: { _id: 1 } },
    ], { allowDiskUse: true }).toArray();
    for (const r of cov) {
      const b = out.branches[r._id.branch] || (out.branches[r._id.branch] = { vouchers: 0, withBills: 0, firstMonthWithBills: null, byMonth: {} });
      b.vouchers += r.vouchers;
      b.withBills += r.withBills;
      b.byMonth[r._id.ym] = { vouchers: r.vouchers, withBills: r.withBills };
      if (r.withBills > 0 && (!b.firstMonthWithBills || r._id.ym < b.firstMonthWithBills)) b.firstMonthWithBills = r._id.ym;
    }

    // 2. the CSV's still-open bills, and whether the vouchers know each reference.
    const aliases = await readAliasMap(db);
    const xd = await mergedHierarchy(db);
    const S = yoy.newSummary(xd, aliases);
    const files = (await db.collection('inputfiles').findOne({ _id: 'inputs' })) || {};
    for (const key of ['kolBillsRecv', 'kolBillsPay', 'ahmBillsPay']) {
      const info = { uploaded: files[key + 'UpdatedAt'] ? new Date(files[key + 'UpdatedAt']).toISOString() : null,
        rows: 0, oldestBill: null, newestBill: null, openTotal: 0,
        matched: 0, matchedTotal: 0, renamed: 0, renamedTotal: 0, renamedSample: [],
        missing: 0, missingTotal: 0, missingSample: [] };
      if (files[key] != null) {
        let rows = [];
        try { rows = E.parseBillsCSV(String(files[key])); } catch (e) { rows = []; }
        info.rows = rows.length;
        for (const b of rows) {
          if (!info.oldestBill || b.date < info.oldestBill) info.oldestBill = b.date;
          if (!info.newestBill || b.date > info.newestBill) info.newestBill = b.date;
          info.openTotal += b.amount || 0;
        }
        // Which of those references the vouchers carry an allocation for. Asked in
        // one query per file rather than one per bill.
        const refs = [...new Set(rows.map((b) => b.refNo).filter(Boolean))];
        const found = new Set();
        for (let i = 0; i < refs.length; i += 1000) {
          const slice = refs.slice(i, i + 1000);
          const hit = await db.collection('vouchers').aggregate([
            { $match: { 'bills.ref': { $in: slice } } },
            { $unwind: '$bills' },
            { $match: { 'bills.ref': { $in: slice } } },
            { $group: { _id: '$bills.ref' } },
          ], { allowDiskUse: true }).toArray();
          for (const h of hit) found.add(h._id);
        }
        // A reference the vouchers do not carry is not yet a missing bill. Tally lets a
        // bill reference be RE-TYPED after the invoice is raised, and the CSV is an old
        // snapshot: it can still name the reference as it was, while the voucher now
        // carries the corrected one. The invoice itself is the same invoice, so it is
        // looked for a second way -- by the voucher NUMBER the CSV reference names,
        // which is what the reference was copied from in the first place.
        const unmatched = rows.filter((b) => !(b.refNo && found.has(b.refNo)));
        const byNo = new Map();
        const nos = [...new Set(unmatched.map((b) => b.refNo).filter(Boolean))];
        for (let i = 0; i < nos.length; i += 1000) {
          const slice = nos.slice(i, i + 1000);
          const vs = await db.collection('vouchers').find({ no: { $in: slice } }).toArray();
          for (const v of vs) {
            if (!v.bills || !v.bills.length) continue;
            const list = byNo.get(v.no) || [];
            list.push(v);
            byNo.set(v.no, list);
          }
        }
        for (const b of rows) {
          if (b.refNo && found.has(b.refNo)) { info.matched++; info.matchedTotal += b.amount || 0; continue; }
          // The same invoice under a new reference: the voucher of that number, carrying
          // an allocation of the same size. Size decides, so an unrelated voucher that
          // happens to share a number is not quietly counted as a match.
          let renamedTo = null;
          for (const v of (byNo.get(b.refNo) || [])) {
            for (const al of (v.bills || [])) {
              if (Math.abs(Math.abs(al.amount || 0) - Math.abs(b.amount || 0)) <= 1) { renamedTo = al.ref; break; }
            }
            if (renamedTo) break;
          }
          if (renamedTo) {
            info.renamed++; info.renamedTotal += b.amount || 0;
            if (info.renamedSample.length < 25) {
              info.renamedSample.push({ ref: b.refNo, renamedTo, date: b.date,
                party: b.party, canonical: S.canon(b.party || ''), amount: b.amount });
            }
          } else {
            info.missing++; info.missingTotal += b.amount || 0;
            if (info.missingSample.length < 25) {
              info.missingSample.push({ ref: b.refNo || '(no reference)', date: b.date,
                party: b.party, canonical: S.canon(b.party || ''), amount: b.amount });
            }
          }
        }
        info.openTotal = Math.round(info.openTotal * 100) / 100;
        info.matchedTotal = Math.round(info.matchedTotal * 100) / 100;
        info.renamedTotal = Math.round(info.renamedTotal * 100) / 100;
        info.missingTotal = Math.round(info.missingTotal * 100) / 100;
      }
      out.csv[key] = info;
    }

    // 3. the verdict, stated plainly rather than left to be inferred.
    const totalMissing = Object.values(out.csv).reduce((a, c) => a + c.missing, 0);
    const missingMoney = Object.values(out.csv).reduce((a, c) => a + c.missingTotal, 0);
    const totalRenamed = Object.values(out.csv).reduce((a, c) => a + c.renamed, 0);
    const renamedNote = totalRenamed
      ? ` ${totalRenamed} more were found under a reference Tally has since re-typed -- the same invoice, a different name.`
      : '';
    out.verdict = {
      csvStillNeeded: totalMissing > 0,
      billsOnlyInCsv: totalMissing,
      moneyOnlyInCsv: Math.round(missingMoney * 100) / 100,
      billsFoundRenamed: totalRenamed,
      says: totalMissing === 0
        ? 'Every bill the uploaded files still show open is also carried by the vouchers.' + renamedNote
          + ' Outstanding can be computed from the vouchers alone, and the upload is no longer the source of anything.'
        : `${totalMissing} bill(s) worth \u20b9${Math.round(missingMoney).toLocaleString('en-IN')} are in the uploaded files and in no voucher we hold.${renamedNote} Retiring the CSV would lose exactly those; re-pull the years they fall in first.`,
    };
    res.json(out);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/bills/audit[?asOn=YYYYMMDD]
// The bills coverage check answers "is every bill somewhere in the vouchers". This
// answers the harder question that has to come next: computed from the vouchers
// alone, does OUTSTANDING come out at the figure Tally itself reported?
//
// Both sides are put at the same instant to make that a fair question. The uploaded
// CSV is a snapshot Tally printed on one date, so the vouchers are netted only up to
// that same date -- every allocation on a bill reference, added up:
//
//   a debtor's bill is raised Dr (-ve) and settled Cr (+ve), so what is still open is
//   -(sum of its allocations); for a creditor the signs are the other way round.
//
// What comes back is a party-by-party comparison, worst difference first. Nothing is
// switched over on the strength of a total agreeing -- two errors can cancel in a
// total, and cannot in a list of parties. Read-only; it changes no figure.
const AUDIT_SIDE = { kolBillsRecv: { branch: 'kol', side: 'debtor' },
  kolBillsPay: { branch: 'kol', side: 'creditor' },
  ahmBillsPay: { branch: 'ahm', side: 'creditor' } };

// WHEN did Tally print this report? Not the newest bill's date -- that is when an
// invoice was raised, and a report printed months later still shows it. Tally works
// out "overdue by N days" against the day it prints, so every row carries the answer:
// due date + overdue days. Rows not yet overdue say 0 and cannot tell us anything, so
// they are skipped, and the day the most rows agree on wins -- one mistyped due date
// then cannot move the date both sides are compared at.
function snapshotDateOf(rows, tally) {
  for (const b of rows) {
    if (!b.dueDate || !b.overdueDays) continue;
    const d = new Date(b.dueDate);
    if (isNaN(d.getTime())) continue;
    d.setUTCDate(d.getUTCDate() + b.overdueDays);
    const k = d.toISOString().slice(0, 10).replace(/-/g, '');
    tally.set(k, (tally.get(k) || 0) + 1);
  }
}

// One party entered under two ledger names shows up here as TWO differences that
// cancel each other to the rupee: the bill was raised against one spelling and
// settled -- or journalled across -- against the other, so one reads over-settled by
// exactly what the other reads unpaid. No money is missing; the name-merge simply has
// not been told they are the same customer.
//
// They are matched by that exact cancellation AND a shared word, so two unrelated
// parties that happen to differ by the same amount are not declared the same
// customer. What comes back is a merge list for the portal's name editor, kept apart
// from the differences that are actually about money.
// Words that say nothing about WHICH company this is. Without them "Krishna Vanijya
// Pvt Ltd" and an unrelated "Private Limited" would look related.
const PAIR_STOP = new Set(['private', 'limited', 'india', 'company', 'sons', 'international',
  'services', 'solutions', 'enterprise', 'enterprises', 'trading', 'industries', 'group']);

function pairOffNames(rows) {
  // Tokenised from the raw name, not through norm(), which strips the separators and
  // would leave one unsplittable word that can never match anything.
  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !PAIR_STOP.has(w)));
  const byAmount = new Map();
  for (const r of rows) {
    const k = Math.round(Math.abs(r.diff));
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(r);
  }
  const pairs = [];
  for (const list of byAmount.values()) {
    const plus = list.filter((r) => r.diff > 0), minus = list.filter((r) => r.diff < 0);
    for (const a of plus) {
      if (a.pairedWith) continue;
      const aw = words(a.party);
      const b = minus.find((x) => !x.pairedWith && [...words(x.party)].some((w) => aw.has(w)));
      if (!b) continue;
      a.pairedWith = b.party; b.pairedWith = a.party;
      pairs.push({ amount: Math.abs(a.diff),
        onlyInVouchers: a.onlyIn === 'vouchers' && b.onlyIn === 'vouchers',
        a: { party: a.party, csv: a.csv, vouchers: a.vouchers },
        b: { party: b.party, csv: b.csv, vouchers: b.vouchers } });
    }
  }
  pairs.sort((x, y) => y.amount - x.amount);
  return pairs;
}

app.get('/api/bills/audit', async (req, res) => {
  try {
    const db = await getDb();
    const aliases = await readAliasMap(db);
    const xd = await mergedHierarchy(db);
    const S = yoy.newSummary(xd, aliases);
    const files = (await db.collection('inputfiles').findOne({ _id: 'inputs' })) || {};

    // The CSV side first: it also fixes the date both sides are measured at.
    const csvOf = {};
    const printedOn = new Map();
    let newestBill = null;
    for (const key of Object.keys(AUDIT_SIDE)) {
      const parties = new Map();
      let rows = [];
      if (files[key] != null) { try { rows = E.parseBillsCSV(String(files[key])); } catch (e) { rows = []; } }
      snapshotDateOf(rows, printedOn);
      for (const b of rows) {
        if (b.date && (!newestBill || b.date > newestBill)) newestBill = b.date;
        const p = S.canon(b.party || '');
        parties.set(p, (parties.get(p) || 0) + (b.amount || 0));
      }
      csvOf[key] = { rows: rows.length, parties };
    }
    let snapshot = null, agreeing = 0;
    for (const [k, c] of printedOn) if (c > agreeing) { snapshot = k; agreeing = c; }
    const snapshotFrom = snapshot ? 'overdue days' : (newestBill ? 'newest bill' : null);
    if (!snapshot) snapshot = newestBill;
    const asOn = /^\d{8}$/.test(String(req.query.asOn || '')) ? String(req.query.asOn) : snapshot;
    if (!asOn) return res.json({ ok: false, error: 'no bills file has been uploaded, so there is nothing to compare against' });

    // The voucher side: every allocation up to that date, netted per bill reference.
    // Every ledger that carries one, not only the Sundry Debtors and Creditors --
    // Tally's outstandings report lists a bill against whatever ledger it was raised
    // on, and dropping the rest would report the file's own rows as missing money.
    const netted = await db.collection('vouchers').aggregate([
      { $match: { date: { $lte: asOn } } },
      { $unwind: '$bills' },
      { $group: { _id: { branch: '$branch', ledger: '$bills.ledger', ref: '$bills.ref' },
        sum: { $sum: '$bills.amount' },
        // The two directions kept apart. A reference we only ever saw ONE side of --
        // an invoice with no settlement, or settlements against an invoice we never
        // saw -- is the signature of half the story being outside what we hold, and
        // it explains most of a party's difference when it explains any of it.
        dr: { $sum: { $cond: [{ $lt: ['$bills.amount', 0] }, { $multiply: ['$bills.amount', -1] }, 0] } },
        cr: { $sum: { $cond: [{ $gt: ['$bills.amount', 0] }, '$bills.amount', 0] } } } },
    ], { allowDiskUse: true }).toArray();

    const vchOf = { kol: new Map(), ahm: new Map() };
    const shapeOf = { kol: new Map(), ahm: new Map() };
    for (const r of netted) {
      const ledger = r._id.ledger, m = vchOf[r._id.branch];
      if (!ledger || !m) continue;
      const open = -r.sum;               // Dr-positive: owed TO us is +ve, owed BY us -ve
      if (Math.abs(open) < 0.5) continue;                        // settled to the rupee
      const p = S.canon(ledger);
      m.set(p, (m.get(p) || 0) + open);
      const sh = shapeOf[r._id.branch].get(p)
        || shapeOf[r._id.branch].set(p, { openRefs: 0, oneSided: 0, oneSidedAmount: 0 }).get(p);
      sh.openRefs++;
      if (r.dr < 0.5 || r.cr < 0.5) { sh.oneSided++; sh.oneSidedAmount += open; }
    }

    // Does the branch even have vouchers reaching back that far? Ahmedabad's start in
    // April 2025, so at a March 2025 snapshot every one of its bills would read as
    // lost -- an artefact of the question, not an answer to it.
    const firstOf = {};
    for (const br of ['kol', 'ahm']) {
      const f = await db.collection('vouchers').find({ branch: br }).sort({ date: 1 }).limit(1).toArray();
      firstOf[br] = f.length ? f[0].date : null;
    }

    const round = (n) => Math.round(n * 100) / 100;
    const out = { ok: true, asOn, snapshot, snapshotFrom, snapshotAgreeingRows: agreeing,
      checkedAt: new Date().toISOString(), branches: {} };
    for (const br of ['kol', 'ahm']) {
      // Both of a branch's files are ONE expectation per party. Tally splits a party
      // into the receivable or the payable report by the SIGN of its balance, not by
      // the group it sits in -- a customer in credit is printed under payables -- so
      // comparing file against file puts the same party on both sides of the answer.
      const csv = new Map();
      let csvRows = 0;
      for (const key of Object.keys(AUDIT_SIDE)) {
        if (AUDIT_SIDE[key].branch !== br) continue;
        const sign = AUDIT_SIDE[key].side === 'debtor' ? 1 : -1;
        csvRows += csvOf[key].rows;
        for (const [p, amt] of csvOf[key].parties) csv.set(p, (csv.get(p) || 0) + sign * amt);
      }
      const vch = vchOf[br];
      const covers = !!firstOf[br] && firstOf[br] <= asOn;
      const rows = [];
      for (const p of new Set([...csv.keys(), ...vch.keys()])) {
        const c = round(csv.get(p) || 0), v = round(vch.get(p) || 0);
        if (Math.abs(c) < 0.5 && Math.abs(v) < 0.5) continue;
        const sh = shapeOf[br].get(p);
        rows.push({ party: p, csv: c, vouchers: v, diff: round(v - c),
          onlyIn: !csv.has(p) ? 'vouchers' : (!vch.has(p) ? 'csv' : null),
          openRefs: sh ? sh.openRefs : 0, oneSidedRefs: sh ? sh.oneSided : 0,
          oneSidedAmount: sh ? round(sh.oneSidedAmount) : 0 });
      }
      rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const off = rows.filter((r) => Math.abs(r.diff) >= 1);
      const pairs = pairOffNames(off);
      const real = off.filter((r) => !r.pairedWith);
      // What SHAPE are the differences that are left? Nearly a thousand rows is not a
      // list anyone reads; the shape says where to look first, and each count carries
      // its money so a large class of small differences is not mistaken for the problem.
      const cls = (r) => (r.onlyIn === 'csv' ? 'onlyInTally'
        : r.onlyIn === 'vouchers' ? (r.diff > 0 ? 'onlyInVouchersOpen' : 'onlyInVouchersOverSettled')
          : 'bothButDiffer');
      const shape = {};
      for (const r of real) {
        const k = cls(r);
        const s = shape[k] || (shape[k] = { parties: 0, money: 0, oneSidedParties: 0 });
        s.parties++; s.money = round(s.money + r.diff);
        // One-sided references are the tell: we hold only the invoice, or only the
        // settlements. Where they dominate a class, the answer is about what the
        // vouchers reach back to, not about the accounting.
        if (r.oneSidedRefs && Math.abs(r.oneSidedAmount) >= Math.abs(r.diff) * 0.5) s.oneSidedParties++;
      }
      out.branches[br] = {
        shape,
        coversDate: covers, firstVoucher: firstOf[br],
        csvRows, csvTotal: round(rows.reduce((a, r) => a + r.csv, 0)),
        vouchersTotal: round(rows.reduce((a, r) => a + r.vouchers, 0)),
        parties: rows.length, agree: rows.length - off.length,
        differ: off.length, namePairs: pairs.length, differAfterPairs: real.length,
        pairs: pairs.slice(0, 100),
        worst: real.slice(0, 100),
        note: covers ? null
          : `This branch's vouchers start ${firstOf[br] || 'nowhere'}, after ${asOn}, so there is nothing to compare them against yet. Ask again with ?asOn= a later date.`,
      };
      out.branches[br].diff = round(out.branches[br].vouchersTotal - out.branches[br].csvTotal);
    }

    const live = Object.values(out.branches).filter((b) => b.coversDate);
    const differ = live.reduce((a, b) => a + b.differAfterPairs, 0);
    const paired = live.reduce((a, b) => a + b.namePairs, 0);
    const parties = live.reduce((a, b) => a + b.parties, 0);
    const pairNote = paired ? ` A further ${paired} are one party under two ledger names, each cancelling the other exactly -- merge those on the portal and they go.` : '';
    out.verdict = {
      partiesCompared: parties, partiesDiffering: differ, namePairs: paired,
      branchesNotCompared: Object.keys(out.branches).filter((b) => !out.branches[b].coversDate),
      safeToSwitch: differ === 0,
      says: differ === 0
        ? `Every one of the ${parties} parties with an open bill comes out at the same figure from the vouchers as from Tally's own snapshot of ${asOn}.${pairNote} Outstanding can be computed from the vouchers.`
        : `${differ} of ${parties} parties come out differently from the vouchers than from Tally's snapshot of ${asOn}.${pairNote} Each is listed with both figures; understand them before switching anything over.`,
    };
    res.json(out);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/yoy/diag?q=<name fragment>[&fy=2026-27][&branch=all|kol|ahm]
// Why a party's figure is what it is -- the question that otherwise takes a
// conversation and a screenshot. Read-only, and it changes nothing.
//
// Three things, in the order you need them:
//   1. every ledger whose name contains `q`, with its group chain -- the usual
//      answer is that the customer has two or three ledgers and each view is
//      showing a different one;
//   2. what the stored fold holds for each of those names, per month;
//   3. every voucher of that year touching any of them, and for each, whether it
//      reached a party's row and WHY -- straight from the fold's own attribution().
app.get('/api/yoy/diag', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ ok: false, error: 'q is required (at least two characters of the name)' });
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const fy = /^\d{4}-\d{2}$/.test(String(req.query.fy || '')) ? String(req.query.fy) : null;
    const db = await getDb();

    const xd = await mergedHierarchy(db);
    const aliases = await readAliasMap(db);
    const S = yoy.newSummary(xd, aliases);

    // 1. the ledgers this name could mean
    const needle = q.toLowerCase();
    const matches = Object.keys(xd.ledgers).filter((n) => n.toLowerCase().includes(needle)).sort();
    const canonOf = {};
    const ledgers = matches.slice(0, 60).map((name) => {
      const canon = S.canon(name);
      canonOf[name] = canon;
      return {
        name, canonical: canon, mergedAway: canon !== name,
        parent: xd.ledgers[name] || null,
        chain: yoy.chainOf(S, name),
        role: yoy.sundryOf(S, name) || 'not a Sundry Debtor or Creditor',
        plCategory: yoy.catOf(S, name) || 'not a P&L account',
        interBranch: !!S.ib[name],
        guid: xd.ids[name] || null,
      };
    });

    // 2. what the stored fold holds, per month, for each measure
    const names = new Set(ledgers.map((l) => l.canonical));
    const stored = {};
    for (const section of Object.keys(yoy.PARTY_SECTIONS)) {
      for (const measure of yoy.PARTY_MEASURES) {
        const doc = await readPartyChunks(db, branch + '|' + section + '|' + measure);
        for (const name of names) {
          if (!doc[name]) continue;
          const years = fy ? (doc[name][fy] ? { [fy]: doc[name][fy] } : {}) : doc[name];
          if (Object.keys(years).length) (stored[name] || (stored[name] = {}))[section + '|' + measure] = years;
        }
      }
    }

    // 3. the vouchers, and what the fold made of each
    const all = new Set([...matches, ...Object.keys(aliases).filter((v) => names.has(aliases[v]))]);
    const match = {};
    if (branch !== 'all') match.branch = branch;
    if (fy) {
      const y = parseInt(fy.slice(0, 4), 10);
      match.date = { $gte: y + '0401', $lte: (y + 1) + '0331' };
    }
    const rows = await db.collection('vouchers').aggregate([
      { $match: match },
      { $addFields: { _k: { $concatArrays: [
        { $map: { input: { $objectToArray: { $ifNull: ['$ledgers', {}] } }, in: '$$this.k' } },
        { $map: { input: { $objectToArray: { $ifNull: ['$party_ledgers', {}] } }, in: '$$this.k' } },
      ] } } },
      { $match: { _k: { $in: [...all] } } },
      { $sort: { date: 1 } },
      { $limit: 201 },
      { $project: { _id: 0, branch: 1, date: 1, no: 1, type: 1, party: 1, ledgers: 1, party_ledgers: 1 } },
    ], { allowDiskUse: true }).toArray();
    const truncated = rows.length > 200;
    if (truncated) rows.length = 200;
    const vouchers = rows.map((v) => yoy.explainVoucher(S, v, branch));

    // 4. the bills -- where the outstanding figure actually comes from
    //
    // A party's outstanding on the Projected page is the uploaded Bills CSV plus the
    // invoices inside the LOADED DATE RANGE, less its receipts. A bill from a year
    // the range does not cover, and older than the CSV snapshot, is in neither -- and
    // simply is not there. Both sources are checked here, across every year, so which
    // of the two is missing it is visible rather than guessed at.
    const bills = { csv: {}, refs: {}, allocations: [], truncated: false };
    const files = (await db.collection('inputfiles').findOne({ _id: 'inputs' })) || {};
    for (const key of ['kolBillsRecv', 'kolBillsPay', 'ahmBillsPay']) {
      const stamp = files[key + 'UpdatedAt'] || files.updatedAt || null;
      if (files[key] == null) { bills.csv[key] = { uploaded: null, rows: 0, mine: [] }; continue; }
      let rows = [];
      try { rows = E.parseBillsCSV(String(files[key])); } catch (e) { rows = []; }
      const mine = rows.filter((b) => all.has(b.party) || names.has(S.canon(b.party || '')));
      let newest = null;
      for (const b of rows) if (!newest || b.date > newest) newest = b.date;
      bills.csv[key] = {
        uploaded: stamp ? new Date(stamp).toISOString() : null,
        rows: rows.length, newestBill: newest,
        mine: mine.map((b) => ({ ref: b.refNo, date: b.date, party: b.party, amount: b.amount, dueDate: b.dueDate, overdueDays: b.overdueDays, isAdvance: b.isAdvance })),
      };
    }
    // Bill-wise allocations carried by the vouchers themselves, every year.
    const bRows = await db.collection('vouchers').aggregate([
      { $match: branch === 'all' ? {} : { branch } },
      { $addFields: { _bl: { $map: { input: { $ifNull: ['$bills', []] }, in: '$$this.ledger' } } } },
      { $match: { _bl: { $in: [...all] } } },
      { $sort: { date: 1 } },
      // A customer of ten years carries hundreds of allocations, and cutting the list
      // short hides the very receipt being looked for -- it made a settled bill read
      // as still open. High enough to cover the largest party here.
      { $limit: 2001 },
      { $project: { _id: 0, branch: 1, date: 1, no: 1, type: 1, bills: 1 } },
    ], { allowDiskUse: true }).toArray();
    bills.truncated = bRows.length > 2000;
    if (bills.truncated) bRows.length = 2000;
    for (const r of bRows) {
      for (const b of (r.bills || [])) {
        if (!all.has(b.ledger)) continue;
        const row = { ref: b.ref, billType: b.type, amount: b.amount, date: r.date, no: r.no, type: r.type, branch: r.branch, ledger: b.ledger };
        bills.allocations.push(row);
        const k = b.ref || '(no reference)';
        const acc = bills.refs[k] || (bills.refs[k] = { ref: k, raised: 0, settled: 0, net: 0, first: r.date, last: r.date });
        // Tally signs: a debtor's bill is raised Dr (-ve) and settled Cr (+ve).
        if (b.amount < 0) acc.raised += -b.amount; else acc.settled += b.amount;
        acc.net = Math.round((acc.raised - acc.settled) * 100) / 100;
        if (r.date < acc.first) acc.first = r.date;
        if (r.date > acc.last) acc.last = r.date;
      }
    }
    // Which references the CSV knows and the vouchers do not, and the other way round.
    const csvRefs = new Set();
    for (const key of Object.keys(bills.csv)) for (const b of bills.csv[key].mine) csvRefs.add(b.ref);
    const vchRefs = new Set(Object.keys(bills.refs));
    bills.onlyInCsv = [...csvRefs].filter((r) => r && !vchRefs.has(r));
    bills.onlyInVouchers = [...vchRefs].filter((r) => r !== '(no reference)' && !csvRefs.has(r));

    res.json({
      ok: true, q, branch, fy,
      aliasesFor: Object.keys(aliases).filter((v) => names.has(aliases[v]) || all.has(v)).map((v) => ({ from: v, to: aliases[v] })),
      ledgers, matched: matches.length, stored, truncated, vouchers, bills,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/yoy/vouchers?branch=&ledger=&from=&to=[&limit=]
// The vouchers behind one account for one period -- what the P&L tab's drill-down
// shows, except the vouchers are not in the browser here, so Mongo finds them.
//
// A ledger name is a KEY inside `ledgers`/`party_ledgers`, and Tally names carry dots
// ("A.B. Traders"), which a dotted query path would read as nesting. So the match is
// done on the key list instead, narrowed first by branch and date so only one year of
// one branch is ever examined.
app.get('/api/yoy/vouchers', async (req, res) => {
  try {
    const ledger = String(req.query.ledger || '');
    if (!ledger) return res.status(400).json({ ok: false, error: 'ledger is required' });
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const from = DATE8.test(String(req.query.from || '')) ? String(req.query.from) : null;
    const to = DATE8.test(String(req.query.to || '')) ? String(req.query.to) : null;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to are required as YYYYMMDD' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);

    const match = { date: { $gte: from, $lte: to } };
    if (branch !== 'all') match.branch = branch;
    const db = await getDb();
    const names = aliasVariants(await readAliasMap(db), ledger);
    const rows = await db.collection('vouchers').aggregate([
      { $match: match },
      { $addFields: { _k: { $concatArrays: [
        { $map: { input: { $objectToArray: { $ifNull: ['$ledgers', {}] } }, in: '$$this.k' } },
        { $map: { input: { $objectToArray: { $ifNull: ['$party_ledgers', {}] } }, in: '$$this.k' } },
      ] } } },
      { $match: { _k: { $in: names } } },
      { $sort: { date: 1 } },
      { $limit: limit + 1 },
      { $project: { _id: 0, branch: 1, date: 1, no: 1, type: 1, party: 1, narration: 1, guid: 1, ledgers: 1, party_ledgers: 1 } },
    ], { allowDiskUse: true }).toArray();

    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    // The amount this account carries on each voucher -- what the drill-down column
    // shows, so the caller does not have to know which side it was booked on.
    for (const r of rows) {
      let amt = 0;
      for (const n of names) {
        amt += (r.ledgers && r.ledgers[n]) || 0;
        amt += (r.party_ledgers && r.party_ledgers[n]) || 0;
      }
      r.amount = Math.round(amt * 100) / 100;
      delete r.ledgers; delete r.party_ledgers;
    }
    res.json({ ledger, branch, from, to, names, count: rows.length, truncated, vouchers: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
// Read-only: explains one party's figure. Changes nothing, so it is not gated.
app.use('/diag', express.static(path.join(REPO_ROOT, 'diag')));
// React and SheetJS, served from here rather than a public CDN. Every page is a
// single React file, so a CDN the office network cannot reach used to leave a
// silently blank page -- nothing renders, and the console only says "React is not
// defined". Serving them ourselves removes that dependency; the pages still keep
// the CDN as a fallback for anyone opening the HTML straight off disk.
app.use('/vendor', express.static(path.join(REPO_ROOT, 'vendor'), { maxAge: '30d', immutable: true }));
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
