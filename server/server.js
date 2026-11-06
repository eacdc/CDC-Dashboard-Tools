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
const LM = require('./loanMovement');

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
// Days before or after a YYYYMMDD, through a real date so month ends and leap years
// look after themselves. Noon, so a daylight-saving jump cannot land on the day before.
function ymdAdd(s, days) {
  if (!isYmd(s)) return s;
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

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
        // Cancelled and optional vouchers are left out, as they are everywhere: the
        // dashboards fold these rows into the P&L themselves, so a draft reaching the
        // browser would show a revenue the server's own year-on-year panel does not.
        .find({ branch, date: { $gte: from, $lte: to }, cancelled: { $ne: true }, optional: { $ne: true } },
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
// Cancelled and optional vouchers are not transactions, and no FIGURE may include
// one. Spread into the $match of every query that totals money or lists the vouchers
// behind a total. Deliberately NOT applied to the coverage counts (/api/meta, bills
// coverage, the first/last stored date), which answer "what do we hold" -- a stored
// draft is held -- nor to /diag's party explainer, whose job is to show every voucher
// it saw and say what it did with it, a draft included.
const LIVE_ONLY = { cancelled: { $ne: true }, optional: { $ne: true } };
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
    .find(q, { projection: { _id: 0, branch: 1, date: 1, type: 1, ledgers: 1, party_ledgers: 1,
      cancelled: 1, optional: 1 } })
    .batchSize(1000);
  for await (const v of cursor) {
    yoy.addVoucher(S, v);
    if (++n % 5000 === 0) { yoyState.progress = n; yoyState.lastProgressAt = Date.now(); }
  }
  yoyState.progress = n; yoyState.lastProgressAt = Date.now();
  const fresh = yoy.finalize(S);

  const prev = (await db.collection('yoy_summary').findOne({ _id: 'summary' })) || { branches: {}, fys: [] };
  let branches, allFys, partyTotals;
  const touched = new Set(fys || []);
  if (!fys || !fys.length) {
    branches = fresh.branches; allFys = fresh.fys; partyTotals = fresh.partyTotals || {};
  } else {
    // Partial: keep every other year exactly as it was, replace only these. A year
    // whose vouchers were all deleted must disappear, so the rebuilt years are
    // cleared first rather than merged over.
    branches = JSON.parse(JSON.stringify(prev.branches || {}));
    for (const b of Object.keys(branches)) for (const f of Object.keys(branches[b])) if (touched.has(f)) delete branches[b][f];
    for (const b of Object.keys(fresh.branches)) {
      branches[b] = branches[b] || {};
      for (const f of Object.keys(fresh.branches[b])) branches[b][f] = fresh.branches[b][f];
    }
    // The party-section totals splice the same way, one level deeper: branch, then
    // section|measure, then year. Merging them over instead of clearing first would
    // leave a year that lost all its vouchers showing its old figure for ever.
    partyTotals = JSON.parse(JSON.stringify(prev.partyTotals || {}));
    for (const b of Object.keys(partyTotals)) for (const k of Object.keys(partyTotals[b])) {
      for (const f of Object.keys(partyTotals[b][k])) if (touched.has(f)) delete partyTotals[b][k][f];
    }
    for (const b of Object.keys(fresh.partyTotals || {})) {
      partyTotals[b] = partyTotals[b] || {};
      for (const k of Object.keys(fresh.partyTotals[b])) {
        partyTotals[b][k] = partyTotals[b][k] || {};
        for (const f of Object.keys(fresh.partyTotals[b][k])) partyTotals[b][k][f] = fresh.partyTotals[b][k][f];
      }
    }
    const s = new Set();
    for (const b of Object.keys(branches)) for (const f of Object.keys(branches[b])) s.add(f);
    allFys = [...s].sort();
  }
  const updatedAt = new Date();
  await db.collection('yoy_summary').updateOne({ _id: 'summary' }, { $set: {
    fys: allFys, branches, partyTotals, scannedVouchers: n, skippedVouchers: S.skipped || 0,
    scope: (fys && fys.length) ? fys : 'all', updatedAt,
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


// GET /api/clients?branch=all|kol|ahm&measure=netpl|net|gross&fromFy=2020-21
// Every Sundry Debtor, with what Tally knows about it and what it has bought.
//
// One row per CLIENT, not per ledger: a customer carrying three spellings is one
// row under the name the merges point at, exactly as every other page counts it.
// Its contact details are taken from whichever of those spellings actually carries
// them -- the current ledger is often the empty one, the details having been typed
// into the spelling that was in use when the account was opened.
//
// The sales figures and the first/last invoice dates come from the SAME fold the
// Sales Analysis tab reads, so a client list handed to a salesperson cannot quietly
// disagree with the dashboard the same salesperson is looking at.
app.get('/api/clients', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const measure = yoy.PARTY_MEASURES.includes(String(req.query.measure)) ? String(req.query.measure) : 'gross';
    const fromFy = /^\d{4}-\d{2}$/.test(String(req.query.fromFy || '')) ? String(req.query.fromFy) : '2020-21';
    const db = await getDb();
    const summary = await db.collection('yoy_summary').findOne({ _id: 'summary' }, { projection: { fys: 1, updatedAt: 1 } });
    const allFys = (summary && summary.fys) || [];
    const fys = allFys.filter((f) => f >= fromFy);

    const xd = await mergedHierarchy(db);
    const aliases = await readAliasMap(db);
    const S = yoy.newSummary(xd, aliases);

    // Contacts live on the branch masters, keyed by the name Tally spells today.
    const contacts = {};
    for (const br of (branch === 'all' ? ['kol', 'ahm'] : [branch])) {
      const m = readMaster(await db.collection('masters').findOne({ branch: br }));
      for (const [ln, c] of Object.entries((m && m.contacts) || {})) {
        contacts[ln] = Object.assign({}, contacts[ln], c);
      }
    }

    const sales = await readPartyChunks(db, branch + '|sales|' + measure);
    const seen = await readPartyChunks(db, branch + '|sales|seen');

    // Every Sundry Debtor in the books, whether or not it has traded since fromFy --
    // a client that has gone quiet is exactly the row a salesperson is looking for.
    const rows = [];
    for (const name of Object.keys(xd.ledgers)) {
      if (S.canon(name) !== name) continue;          // a merged-away spelling is not a row
      if (yoy.sundryOf(S, name) !== 'debtor') continue;
      const variants = aliasVariants(aliases, name);
      const pick = (f) => {
        for (const v of variants) { const c = contacts[v]; if (c && c[f]) return String(c[f]); }
        return '';
      };
      const byFy = {};
      let total = 0;
      const perFy = sales[name] || {};
      for (const fy of fys) {
        const a = perFy[fy];
        const t = a ? Math.round(a.reduce((x, y) => x + (y || 0), 0) * 100) / 100 : 0;
        byFy[fy] = t;
        total += t;
      }
      // First and last invoice, over the years being reported. Asked for a window
      // starting in 2020, "first sale" means the first one IN it -- a date from 2016
      // would answer a question nobody asked and read as a gap in the columns.
      let first = '', last = '';
      const sf = seen[name] || {};
      for (const fy of fys) {
        const s = sf[fy];
        if (!s) continue;
        if (!first || s.first < first) first = s.first;
        if (!last || s.last > last) last = s.last;
      }
      rows.push({
        ledger: name,
        group: xd.ledgers[name] || '',
        chain: yoy.chainOf(S, name).join(' > '),
        gstin: pick('gstin'), pan: pick('pan'),
        address: pick('address'), state: pick('state'), country: pick('country'),
        contact: pick('name'), mobile: pick('mobile'), phone: pick('phone'), email: pick('email'),
        firstSale: first, lastSale: last,
        salesByFy: byFy, totalSales: Math.round(total * 100) / 100,
        mergedFrom: variants.filter((v) => v !== name),
      });
    }
    rows.sort((a, b) => b.totalSales - a.totalSales);
    // What the master does NOT hold is worth a number: the pipeline only started
    // pulling PAN and the address block in v2.54, so before a sync has run those
    // columns are empty for everybody and the sheet looks broken rather than new.
    const have = (f) => rows.filter((r) => r[f]).length;
    // The dates are counted against the rows that could HAVE one -- a client with no
    // sale in the window has no first sale, and counting it as missing would read as
    // a broken fold for ever. Short of `traded`, and the fold has not covered every
    // year since the dates were added: one full rebuild (POST /api/yoy/scan, no fy)
    // writes them, after which the 30-minute sync keeps them current year by year.
    const traded = rows.filter((r) => r.totalSales).length;
    res.json({ ok: true, branch, measure, fromFy, fys, clients: rows.length,
      filled: { gstin: have('gstin'), pan: have('pan'), address: have('address'),
        state: have('state'), country: have('country'), contact: have('contact'),
        mobile: have('mobile'), phone: have('phone'), email: have('email'),
        firstSale: have('firstSale'), lastSale: have('lastSale') },
      traded,
      datesComplete: have('lastSale') >= traded,
      updatedAt: (summary && summary.updatedAt) || null, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// The calendar month a slot of the year-on-year arrays stands for. Month 0 is APRIL
// -- the books' first month, not January -- so slots 9..11 fall in the next calendar
// year. Returned as "YYYYMM" because that is what `date.slice(0,6)` on a voucher
// gives, and a caller joining the two should not have to know this rule at all.
function slotMonth(fy, i) {
  const y = parseInt(String(fy).slice(0, 4), 10);
  const m = i + 4;
  return m <= 12 ? String(y) + ('0' + m).slice(-2) : String(y + 1) + ('0' + (m - 12)).slice(-2);
}

// GET /api/sales/monthly?branch=all|kol|ahm&measure=netpl|net|gross&fromFy=2020-21
//                       &section=sales|purchase&min=0
// One row per customer, one column per CALENDAR MONTH, flat.
//
// The same numbers `/api/yoy/party` serves, and the same fold behind them -- but that
// one answers with the drill-down tree the dashboard draws (salesperson > group >
// party, monthly figures sparse-keyed by a slot index into a decade laid end to end).
// That is the right shape for a panel that opens one branch at a time and the wrong
// one for a caller that wants "who bought in September". Walking someone else's tree
// and re-deriving which slot was which month is where an integration invents its own
// off-by-one, so the months are named here, once, by `slotMonth`.
//
// Reads the stored fold, never the vouchers: a month-by-month answer for every
// customer over a decade is two scans of the whole collection if computed live, and
// it would also be free to disagree with the dashboard. Costs one query per key.
app.get('/api/sales/monthly', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const measure = yoy.PARTY_MEASURES.includes(String(req.query.measure)) ? String(req.query.measure) : 'gross';
    const section = yoy.PARTY_SECTIONS[String(req.query.section)] ? String(req.query.section) : 'sales';
    const fromFy = /^\d{4}-\d{2}$/.test(String(req.query.fromFy || '')) ? String(req.query.fromFy) : '2020-21';
    const min = Number(req.query.min) > 0 ? Number(req.query.min) : 0;

    const db = await getDb();
    const summary = await db.collection('yoy_summary').findOne({ _id: 'summary' }, { projection: { fys: 1, updatedAt: 1 } });
    const fys = (((summary && summary.fys) || []).filter((f) => f >= fromFy));
    const months = [];
    for (const fy of fys) for (let i = 0; i < 12; i++) months.push(slotMonth(fy, i));

    const party = await readPartyChunks(db, branch + '|' + section + '|' + measure);
    const seen = await readPartyChunks(db, branch + '|' + section + '|seen');

    const rows = [];
    for (const name of Object.keys(party)) {
      const byMonth = {};
      let total = 0;
      for (const fy of fys) {
        const a = party[name][fy];
        if (!a) continue;
        for (let i = 0; i < 12; i++) {
          const v = Math.round((a[i] || 0) * 100) / 100;
          if (v) { byMonth[slotMonth(fy, i)] = v; total += v; }
        }
      }
      total = Math.round(total * 100) / 100;
      if (!total || total < min) continue;
      let first = '', last = '';
      const sf = seen[name] || {};
      for (const fy of fys) {
        const s = sf[fy];
        if (!s) continue;
        if (!first || s.first < first) first = s.first;
        if (!last || s.last > last) last = s.last;
      }
      // Sparse on purpose: a decade is 120 columns and a customer trades in a handful
      // of them. A month absent from byMonth is a month with no invoice, which is the
      // whole question behind "bought last month but not this".
      rows.push({ ledger: name, total, firstSale: first, lastSale: last, byMonth });
    }
    rows.sort((a, b) => b.total - a.total);
    const dated = rows.filter((r) => r.lastSale).length;
    res.json({ ok: true, branch, measure, section, fromFy, fys, months,
      parties: rows.length, traded: rows.length,
      filled: { lastSale: dated }, datesComplete: dated >= rows.length,
      updatedAt: (summary && summary.updatedAt) || null, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/products?branch=all|kol|ahm&from=YYYYMMDD&to=YYYYMMDD&by=product|hsn
//                  &party=<canonical name>&limit=500
// What was actually sold, by stock item, over a date window -- and for one customer
// when `party` is given.
//
// This one DOES read the vouchers, because line items are not folded anywhere: they
// live in `details.items`, which `/api/dataset` deliberately projects away. So it is
// the one endpoint here with a cost proportional to the window, and the window is
// therefore bounded (one financial year by default) and the scan is reported.
//
// Three things it does NOT leave to the caller, each of which is a wrong number
// waiting to happen:
//
//   * WHOSE invoice it was. The fold gives the whole invoice to the largest Sundry
//     Debtor on it; a caller unwinding `party_ledgers` instead would book sales
//     against banks and against the other branch. The dominant party comes from
//     `attribution()` itself, so this endpoint and the dashboard cannot disagree.
//   * WHICH product. Tally's description block is the stock item, then the user's
//     own description lines, then the batch, joined by newlines -- so the product is
//     its FIRST LINE and grouping on the whole string scatters one item over dozens
//     of rows.
//   * The QUANTITY's unit. `qty` is a string and `unit` is separate, and one item can
//     be billed in Nos on one invoice and Kgs on the next. Quantities are therefore
//     summed PER UNIT and never added across units.
app.get('/api/products', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const BY = ['product', 'hsn', 'party'];
    const by = BY.includes(String(req.query.by)) ? String(req.query.by) : 'product';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // Default window: the financial year in progress, in the books' own timezone.
    const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
    const fyStart = (nowIst.getUTCMonth() + 1 >= 4 ? nowIst.getUTCFullYear() : nowIst.getUTCFullYear() - 1);
    const from = DATE8.test(String(req.query.from || '')) ? String(req.query.from) : String(fyStart) + '0401';
    const to = DATE8.test(String(req.query.to || '')) ? String(req.query.to) : String(fyStart + 1) + '0331';
    if (to < from) return res.status(400).json({ ok: false, error: `to (${to}) is before from (${from})` });
    // A window is one financial year at most. This endpoint reads vouchers rather than
    // the fold, so a decade asked for in one call is a full scan with items parsed --
    // minutes on the free plan, and the proxy hangs up long before it answers. Refused
    // with the limit named, because a truncated answer to "what did we sell" is worse
    // than an error: nothing in it says which part is missing.
    const span = (Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8))
      - Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8))) / 86400000;
    if (span > 400) {
      return res.status(400).json({ ok: false,
        error: `window is ${Math.round(span)} days; one financial year (400) is the limit. Ask for each year separately.` });
    }

    const db = await getDb();
    const xd = await mergedHierarchy(db);
    const aliases = await readAliasMap(db);
    const S = yoy.newSummary(xd, aliases);
    // One customer asked for: match every spelling merged into that name, because the
    // vouchers keep whatever was typed at the time.
    const wanted = req.query.party ? new Set(aliasVariants(aliases, S.canon(String(req.query.party)))) : null;

    const q = { date: { $gte: from, $lte: to }, 'details.items.0': { $exists: true },
      cancelled: { $ne: true }, optional: { $ne: true } };
    if (branch !== 'all') q.branch = branch;
    const cursor = db.collection('vouchers')
      .find(q, { projection: { _id: 0, branch: 1, date: 1, no: 1, type: 1,
        ledgers: 1, party_ledgers: 1, 'details.items': 1 } })
      .batchSize(500);

    const acc = new Map();
    let scanned = 0, counted = 0;
    // WHY a scanned voucher did not count. "unattributed" alone could not answer the
    // question it raises -- a window where half the vouchers are unattributed is
    // either perfectly normal (a purchase with stock items is not a sale) or a hole in
    // the revenue, and those two want opposite responses. So the two are counted
    // apart, and the second one is named: voucher type and number, to look up.
    const skipped = { notASale: 0, saleWithoutDebtor: 0, otherCustomer: 0 };
    const byType = {};
    const sample = [];
    for await (const v of cursor) {
      scanned++;
      // The query asks Mongo for vouchers that carry items, but a voucher without
      // them must cost nothing here rather than throw: this endpoint is the one that
      // reads raw vouchers, and the shape of `details` is optional by design.
      const items = (v.details && Array.isArray(v.details.items)) ? v.details.items : [];
      if (!items.length) continue;
      const ledgers = yoy.canonKeys(S, v.ledgers);
      const parties = yoy.canonKeys(S, v.party_ledgers);
      const a = yoy.attribution(S, ledgers, parties, branch === 'all');
      const buyer = a.dd;                      // the dominant Sundry Debtor
      // Exactly the fold's own test for a sale (`nr !== 0 && dd`), so a voucher that
      // counts here counts there. A purchase with stock items has a creditor and no
      // debtor; a stock journal or a delivery note has neither.
      if (a.nr === 0) {
        skipped.notASale++;
        byType[v.type || '(no type)'] = (byType[v.type || '(no type)'] || 0) + 1;
        continue;
      }
      if (!buyer) {
        // A sale whose revenue nobody is on the hook for. This is the one that can
        // mean lost revenue -- an inter-branch sale dropped by consolidation, or a
        // debtor sitting under a group the hierarchy does not reach.
        skipped.saleWithoutDebtor++;
        byType[v.type || '(no type)'] = (byType[v.type || '(no type)'] || 0) + 1;
        if (sample.length < 20) {
          sample.push({ date: v.date, no: v.no || '', type: v.type || '', branch: v.branch,
            revenue: Math.round(a.nr * 100) / 100, parties: Object.keys(parties).slice(0, 6) });
        }
        continue;
      }
      if (wanted && !wanted.has(buyer)) { skipped.otherCustomer++; continue; }
      counted++;
      for (const it of items) {
        const product = String(it.description || '').split('\n')[0].trim() || '(unnamed item)';
        const hsn = String(it.hsn || '') || '(no HSN)';
        // by=party keys on the CUSTOMER and the product together, which is the row a
        // CRM wants: one customer, one item, what it came to. The customer is the
        // canonical name, so it joins straight onto /api/clients.
        const key = by === 'hsn' ? hsn : (by === 'party' ? buyer + '\u0000' + product : product);
        let row = acc.get(key);
        if (!row) {
          row = { key, ledger: by === 'party' ? buyer : undefined,
            name: by === 'hsn' ? hsn : product,
            value: 0, vouchers: 0, qtyByUnit: {}, customers: new Set(),
            firstSale: v.date, lastSale: v.date, hsn: by === 'hsn' ? hsn : String(it.hsn || '') };
          acc.set(key, row);
        }
        row.value += Number(it.amount) || 0;
        row.vouchers++;
        row.customers.add(buyer);
        if (v.date < row.firstSale) row.firstSale = v.date;
        if (v.date > row.lastSale) row.lastSale = v.date;
        const qn = parseFloat(String(it.qty || '').replace(/,/g, ''));
        if (isFinite(qn) && qn) {
          const u = String(it.unit || '').trim() || '(no unit)';
          row.qtyByUnit[u] = Math.round(((row.qtyByUnit[u] || 0) + qn) * 1000) / 1000;
        }
      }
    }
    const all = [...acc.values()]
      .map((r) => {
        const out = { name: r.name, hsn: r.hsn, value: Math.round(r.value * 100) / 100,
          vouchers: r.vouchers, customers: r.customers.size, qtyByUnit: r.qtyByUnit,
          firstSale: r.firstSale, lastSale: r.lastSale };
        if (r.ledger) return Object.assign({ ledger: r.ledger }, out);
        return out;
      })
      // Sorted by size, then by name: paging over a list whose ties fall in whatever
      // order a Map happened to hold them repeats one row and drops another.
      .sort((x, y) => (Math.abs(y.value) - Math.abs(x.value))
        || String(x.ledger || '').localeCompare(String(y.ledger || ''))
        || String(x.name).localeCompare(String(y.name)));
    const page = all.slice(offset, offset + limit);
    res.json({ ok: true, branch, by, from, to,
      party: req.query.party ? S.canon(String(req.query.party)) : null,
      rows_total: all.length, products: all.length, offset, limit, returned: page.length,
      truncated: offset + page.length < all.length,
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
      scanned, counted, skipped,
      // Kept for callers written against the first version: every scanned voucher that
      // did not count, whatever the reason.
      unattributed: skipped.notASale + skipped.saleWithoutDebtor,
      byTypeNotCounted: byType, saleWithoutDebtorSample: sample,
      rows: page });
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
    // A branch's two files are ONE expectation per party. Tally splits a party between
    // the receivable and the payable report by the SIGN of its balance, not by the
    // group it sits in -- a customer in credit is printed under payables -- so
    // comparing file against file puts the same party on both sides of the answer.
    const csvByBranch = { kol: new Map(), ahm: new Map() }, csvRowsOf = { kol: 0, ahm: 0 };
    for (const key of Object.keys(AUDIT_SIDE)) {
      const br = AUDIT_SIDE[key].branch, sign = AUDIT_SIDE[key].side === 'debtor' ? 1 : -1;
      csvRowsOf[br] += csvOf[key].rows;
      for (const [p, amt] of csvOf[key].parties) csvByBranch[br].set(p, (csvByBranch[br].get(p) || 0) + sign * amt);
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
      { $match: { date: { $lte: asOn }, ...LIVE_ONLY } },
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
    // Every ledger Tally keeps bill-by-bill, whatever group it sits in. Tally's own
    // Outstandings report counts exactly these, so a ledger here that our balance
    // filter drops is money Tally reports and we do not -- which is the shape a
    // shortfall against Tally's totals takes.
    const billLedgers = { kol: new Set(), ahm: new Set() };
    for (const r of netted) {
      const ledger = r._id.ledger, m = vchOf[r._id.branch];
      if (!ledger || !m) continue;
      const open = -r.sum;               // Dr-positive: owed TO us is +ve, owed BY us -ve
      if (Math.abs(open) < 0.5) continue;                        // settled to the rupee
      const p = S.canon(ledger);
      m.set(p, (m.get(p) || 0) + open);
      billLedgers[r._id.branch].add(p);
      const sh = shapeOf[r._id.branch].get(p)
        || shapeOf[r._id.branch].set(p, { openRefs: 0, oneSided: 0, oneSidedAmount: 0 }).get(p);
      sh.openRefs++;
      if (r.dr < 0.5 || r.cr < 0.5) { sh.oneSided++; sh.oneSidedAmount += open; }
    }

    // And the third reading, which needs no bill references at all: the party's own
    // LEDGER BALANCE. Bill-reference netting is only ever as good as the references
    // Tally was given -- an old receipt posted on account, or a year-end "Due As on"
    // balancing bill, leaves invoices reading open forever though the customer paid.
    // A balance cannot drift that way, so where the two disagree it is the references
    // that are incomplete, not the money.
    //
    // A balance is TWO things, and adding vouchers up gives only one of them:
    //
    //     what a party owes = its opening balance + every posting since
    //
    // The opening is what was already owed before the oldest voucher we hold, and no
    // amount of allocation completeness recovers it. It comes from the ledger master
    // (`opening`/`openingAsOn`) -- a STORED Tally field, unlike the closing balance,
    // which Tally has to walk every posting to work out and would not produce for 886
    // ledgers in five minutes. Postings are then counted from that same day forward,
    // never earlier, or the opening would be counted twice.
    const balOf = { kol: new Map(), ahm: new Map() };
    const openOf = { kol: null, ahm: null };
    const missedOf = { kol: new Map(), ahm: new Map() };
    for (const br of ['kol', 'ahm']) {
      const m = readMaster(await db.collection('masters').findOne({ branch: br }));
      const openMap = (m && m.opening && Object.keys(m.opening).length) ? m.opening : null;
      // ONE date, and a usable one. Tally can answer a field twice, and the array that
      // makes travels all the way here -- where Mongo compares a date STRING against
      // it, matches no voucher at all, and quietly hands back the openings alone
      // dressed up as a balance. A date that is not eight digits is no date, so the
      // openings are refused with it rather than half-applied.
      // Tally can answer a field twice, and the array that makes travels all the way
      // here -- where Mongo compares a date STRING against it, matches no voucher at
      // all, and quietly hands back the openings alone dressed up as a balance. The
      // same date twice is harmless and taken; two DIFFERENT dates are a disagreement
      // nobody should resolve by guessing, so the openings are refused with them.
      const seen = [...new Set([].concat(m ? m.openingAsOn : []).map((x) => String(x || '')))];
      const from = (openMap && seen.length === 1 && /^\d{8}$/.test(seen[0])) ? seen[0] : null;
      openOf[br] = {
        asOn: from, ledgers: openMap ? Object.keys(openMap).length : 0,
        // The day comes from the company's BOOKSFROM -- Tally's own field, read off the
        // company rather than computed, so asking for it costs nothing. An older pull
        // guessed the day instead (1 April of the year the last entry fell in, a year
        // too late, which dropped a whole financial year of postings from every ledger);
        // masters written by it still carry the flag, and a guessed date is said
        // plainly, because one presented as Tally's word is how a year goes missing.
        derived: !!(m && m.openingAsOnDerived),
        note: from ? null
          : (openMap
            ? `Tally's opening balances arrived but the day they stand on did not (${JSON.stringify(m.openingAsOn)}), so they cannot be added to anything and are left out. This is movement since the oldest voucher held, not a balance.`
            : "No pull has brought Tally's opening balances yet, so this is movement since the oldest voucher held, not a balance. Run the pipeline once and ask again."),
      };

      // Only ledgers that can BE outstanding. Every posting in the books nets to zero
      // by double entry, so sweeping in the sales, bank and expense ledgers would
      // report a grand total of exactly nothing and bury the parties among them.
      // What the filter turns away, kept rather than dropped on the floor: a ledger
      // Tally keeps bill-by-bill but that sits outside Sundry Debtors and Creditors --
      // an advance, a deposit, a branch account -- is money Tally's Outstandings
      // counts and this does not. Naming those is how a shortfall gets found instead
      // of guessed at.
      const missed = new Map();
      const add = (ledger, open) => {
        if (!ledger) return;
        // Classified by the name it MERGES INTO, which is what the fold does
        // (canonKeys runs before sundryOf there). Asking the raw spelling instead left
        // an old, renamed ledger unclassified for ever: merging it into the current
        // name -- the whole remedy for a ledger no master defines -- changed nothing
        // here, and its money stayed out of outstanding. The raw name is still tried
        // as a fallback, for a merge that points somewhere the master does not know.
        const p = S.canon(ledger);
        const side = yoy.sundryOf(S, p) || yoy.sundryOf(S, ledger);
        if (side !== 'debtor' && side !== 'creditor' && !csvByBranch[br].has(p)) {
          if (billLedgers[br].has(p)) missed.set(p, (missed.get(p) || 0) + open);
          return;
        }
        balOf[br].set(p, (balOf[br].get(p) || 0) + open);
      };

      // The opening first, on the same Dr-positive scale as everything else.
      //
      // It stands at the START of its day, which is the same instant as the END of the
      // day before -- so an opening dated 1 April IS the balance on 31 March, and asking
      // as at 31 March must use it. Comparing `from <= asOn` alone refused it and
      // returned zero for every party, at exactly the date the page tells you to press:
      // the bills file was printed 31 March 2025 and the openings stand on 1 April 2025,
      // the one date where the two sources CAN be put side by side.
      const opensOn = from ? ymdAdd(from, -1) : null;
      if (opensOn && opensOn <= asOn) for (const [ln, amt] of Object.entries(openMap)) add(ln, -amt);

      // Then the postings, from the day the opening stands on -- anything earlier is
      // already inside it.
      const match = { branch: br, date: { $lte: asOn }, ...LIVE_ONLY };
      if (from) match.date.$gte = from;
      const moved = await db.collection('vouchers').aggregate([
        { $match: match },
        { $project: { kv: { $concatArrays: [
          { $objectToArray: { $ifNull: ['$party_ledgers', {}] } },
          { $objectToArray: { $ifNull: ['$ledgers', {}] } }] } } },
        { $unwind: '$kv' },
        { $group: { _id: '$kv.k', sum: { $sum: '$kv.v' } } },
      ], { allowDiskUse: true }).toArray();
      for (const r of moved) add(r._id, -r.sum);
      missedOf[br] = missed;
    }

    // Does the branch even have vouchers reaching back that far? Ahmedabad's start in
    // April 2025, so at a March 2025 snapshot every one of its bills would read as
    // lost -- an artefact of the question, not an answer to it.
    const firstOf = {};
    for (const br of ['kol', 'ahm']) {
      const f = await db.collection('vouchers').find({ branch: br }).sort({ date: 1 }).limit(1).toArray();
      firstOf[br] = f.length ? f[0].date : null;
    }

    // The opening stands on a day; the postings have to reach back to that same day or
    // the difference is simply absent. Kolkata's vouchers begin a decade before its
    // books date, so there is normally slack here -- but a branch loaded only from last
    // April, against a books date older than that, would understate every party at once
    // and look entirely reasonable doing it. Say it rather than let it pass.
    for (const br of ['kol', 'ahm']) {
      const o = openOf[br];
      if (!o || !o.asOn) continue;
      o.firstVoucher = firstOf[br];
      o.gap = !!(firstOf[br] && firstOf[br] > o.asOn);
      if (o.gap) {
        // A question, not a verdict. The first time this fired, the answer was that
        // Ahmedabad simply had no entries on the day its books open -- and it had
        // announced "every figure here is short", which sent somebody to re-pull a day
        // that held nothing. A guard that cannot tell an empty day from a missing one
        // must say which it cannot tell.
        o.note = `The opening balances stand on ${o.asOn} and the oldest ${br} voucher held is ${firstOf[br]}. If anything was posted in between it is in neither half; if nothing was, this is fine. Re-pull those days to settle it.`;
      }
    }

    const round = (n) => Math.round(n * 100) / 100;
    const out = { ok: true, asOn, snapshot, snapshotFrom, snapshotAgreeingRows: agreeing,
      checkedAt: new Date().toISOString(), branches: {} };
    for (const br of ['kol', 'ahm']) {
      const csv = csvByBranch[br], csvRows = csvRowsOf[br];
      const vch = vchOf[br];
      const covers = !!firstOf[br] && firstOf[br] <= asOn;
      const rows = [];
      for (const p of new Set([...csv.keys(), ...vch.keys(), ...balOf[br].keys()])) {
        const c = round(csv.get(p) || 0), v = round(vch.get(p) || 0);
        if (Math.abs(c) < 0.5 && Math.abs(v) < 0.5 && Math.abs(balOf[br].get(p) || 0) < 0.5) continue;
        const sh = shapeOf[br].get(p);
        const bal = round(balOf[br].get(p) || 0);
        rows.push({ party: p, csv: c, vouchers: v, diff: round(v - c),
          balance: bal, balanceDiff: round(bal - c),
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
        // The same comparison run on the ledger balance instead of the bill netting.
        // If this agrees where the other does not, outstanding should be built on the
        // balance and the references kept for the ageing only.
        // Where the opening half of the balance came from, and the day it stands
        // on -- or why there is not one yet, so a partial figure is never read as a
        // whole one.
        opening: openOf[br],
        // Ledgers Tally keeps bill-by-bill that this balance leaves out, because they
        // sit outside Sundry Debtors and Creditors. Tally's own Outstandings counts
        // them, so this is where a shortfall against its totals will be found -- named,
        // with the group each sits in, rather than left as an unexplained difference.
        outsideParties: (() => {
          const rows = [...missedOf[br].entries()]
            .filter(([, v]) => Math.abs(v) >= 0.5)
            .map(([party, amount]) => ({ party, amount: round(amount),
              group: yoy.chainOf(S, party).join(' > ') }))
            .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
          return { count: rows.length, total: round(rows.reduce((a, r) => a + r.amount, 0)),
            worst: rows.slice(0, 100) };
        })(),
        balanceTotal: round(rows.reduce((a, r) => a + r.balance, 0)),
        balanceAgree: rows.filter((r) => Math.abs(r.balanceDiff) < 1).length,
        balanceDiffer: rows.filter((r) => Math.abs(r.balanceDiff) >= 1).length,
        balanceWorst: rows.slice().filter((r) => Math.abs(r.balanceDiff) >= 1)
          .sort((a, b) => Math.abs(b.balanceDiff) - Math.abs(a.balanceDiff)).slice(0, 100),
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
    // Asked at any date but the one Tally printed the file on, the file is stale by
    // definition and disagreeing with it proves nothing -- so there is no verdict to
    // give. Saying "not yet" there would be crying wolf at the calendar.
    const atSnapshot = asOn === snapshot;
    const balTotal = round(live.reduce((a, b) => a + b.balanceTotal, 0));
    // What the FILE holds that the vouchers do not. Nothing else can keep the file
    // alive: a difference the other way is the vouchers knowing more, not less.
    const lonely = live.reduce((a, b) => {
      const t = (b.shape && b.shape.onlyInTally) || { parties: 0, money: 0 };
      return { parties: a.parties + t.parties, money: a.money + t.money };
    }, { parties: 0, money: 0 });
    out.verdict = {
      partiesCompared: parties, partiesDiffering: differ, namePairs: paired,
      onlyInTheFile: { parties: lonely.parties, money: round(lonely.money) },
      branchesNotCompared: Object.keys(out.branches).filter((b) => !out.branches[b].coversDate),
      comparable: atSnapshot,
      safeToSwitch: atSnapshot && differ === 0,
      says: !atSnapshot
        ? `Nothing is being tested here. The uploaded file is what Tally printed on ${snapshot}, and this is asked as at ${asOn} -- the parties have traded in between, so differing from it is expected and proves nothing either way. What this date DOES give is outstanding as the vouchers and Tally's own openings have it: ₹${Math.round(balTotal).toLocaleString('en-IN')}. Check that against Tally itself; the file cannot judge it. Press "the file's date" for the comparison that can.`
        : differ === 0
        ? `Every one of the ${parties} parties with an open bill comes out at the same figure from the vouchers as from Tally's own snapshot of ${asOn}.${pairNote} Outstanding can be computed from the vouchers.`
        // Two questions get confused here, and the count of differences answers the
        // less useful one. "Can the file be retired" is decided by what the file holds
        // that the vouchers DO NOT -- everything else is the vouchers knowing more.
        // "Do the two agree bill for bill" is a different question, and a party settled
        // ON ACCOUNT rather than against its bills answers it no while owing nothing:
        // its bills stay open on paper and its balance is square. So the shortfall is
        // stated first, and the count of differences is described for what it is.
        : `${lonely.parties === 0
            ? 'Nothing in the file is missing from the vouchers'
            : `${lonely.parties} ${lonely.parties === 1 ? 'party' : 'parties'} and ₹${Math.round(Math.abs(lonely.money)).toLocaleString('en-IN')} appear in the file and nowhere in the vouchers`}`
          + ` -- that is the only figure that decides whether the file still holds anything.`
          + ` The other way round, ${differ} of ${parties} parties net differently bill for bill.${pairNote}`
          + ` Much of that is a party settled ON ACCOUNT rather than against its bills: the bills stay open on paper while the balance is square, and both are right.`
          + ` The balance is the figure to trust and the one to check against Tally -- a ledger at a time, on /diag/ledger.html.`,
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

    // A name can be on the VOUCHERS and in no master at all -- a ledger renamed or
    // deleted in Tally since, whose old entries keep the old spelling. Those are exactly
    // the ones that classify as "Unclassified", drop out of debtor/creditor, and are
    // left out of outstanding. Searching only the master meant the one ledger you came
    // here to ask about was the one the page could not find. So the vouchers are asked
    // too: every ledger name they use, and which of them no master knows.
    const scope = branch === 'all' ? ['kol', 'ahm'] : [branch];
    const orphans = new Map();
    for (const br of scope) {
      const rows = await db.collection('vouchers').aggregate([
        { $match: { branch: br, ...LIVE_ONLY } },
        { $project: { kv: { $concatArrays: [
          { $objectToArray: { $ifNull: ['$party_ledgers', {}] } },
          { $objectToArray: { $ifNull: ['$ledgers', {}] } }] } } },
        { $unwind: '$kv' },
        { $group: { _id: '$kv.k', n: { $sum: 1 }, sum: { $sum: '$kv.v' } } },
      ], { allowDiskUse: true }).toArray();
      for (const r of rows) {
        const n = String(r._id || '');
        if (!n || xd.ledgers[n] !== undefined) continue;      // the master knows it
        const o = orphans.get(n) || { name: n, vouchers: 0, amount: 0, branches: [] };
        o.vouchers += r.n;
        o.amount = Math.round((o.amount - r.sum) * 100) / 100; // Dr-positive, as everywhere
        if (!o.branches.includes(br)) o.branches.push(br);
        orphans.set(n, o);
      }
    }
    const orphanHits = [...orphans.values()].filter((o) => o.name.toLowerCase().includes(needle))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    for (const o of orphanHits) matches.push(o.name);
    matches.sort();

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
        // Said outright, because "Unclassified" on its own reads as a classification
        // problem when it is a MISSING LEDGER: the vouchers use this name and no
        // master defines it, so nothing can be worked out about it at all.
        notInMaster: orphans.has(name) || undefined,
        onVouchers: orphans.has(name) ? orphans.get(name).vouchers : undefined,
        whyUnclassified: orphans.has(name)
          ? 'No master defines this ledger, so it has no group and cannot be a debtor or creditor. '
            + 'Tally has since renamed or deleted it, and these vouchers keep the spelling of the day. '
            + 'Merge it into the current name on the portal, and every figure of its follows.'
          : undefined,
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
      { $match: branch === 'all' ? { ...LIVE_ONLY } : { branch, ...LIVE_ONLY } },
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
    // What this party actually OWES, the way outstanding is meant to be computed: the
    // opening balance Tally itself carries, plus every posting to the name since that
    // day. Shown per ledger and totalled over all the spellings, so the one figure a
    // customer asks about -- "what is pending against me" -- can be read here and put
    // beside Tally without adding vouchers up by hand.
    // Today, in the books' own timezone. The server runs in UTC and India is 5.5 hours
    // ahead, so until half past five in the morning here UTC is still on yesterday --
    // and a balance would drop a whole day's entries for no reason anyone could see.
    const upTo = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    const balance = { asOn: null, upTo, opening: 0, postings: 0, later: 0, total: 0,
      byBranch: {}, byLedger: {}, byMonth: {} };
    for (const br of (branch === 'all' ? ['kol', 'ahm'] : [branch])) {
      const mm = readMaster(await db.collection('masters').findOne({ branch: br }));
      const seenDates = [...new Set([].concat(mm ? mm.openingAsOn : []).map((x) => String(x || '')))];
      const from = (seenDates.length === 1 && /^\d{8}$/.test(seenDates[0])) ? seenDates[0] : null;
      let op = 0, po = 0;
      // Per ledger as well as in total. A customer under three spellings is one
      // customer here, but Tally is asked one ledger at a time -- and comparing our
      // sum of three against Tally's one is how two right answers look wrong.
      // Per ledger, and split into its two halves. If a ledger disagrees with Tally,
      // which half is wrong IS the diagnosis: a wrong opening means the master, a wrong
      // postings figure means vouchers we do not hold. One number cannot say which.
      const each = (ln, half, amt) => {
        const e = balance.byLedger[ln] || (balance.byLedger[ln] = { opening: 0, postings: 0, later: 0, total: 0 });
        e[half] = Math.round((e[half] + amt) * 100) / 100;
        e.total = Math.round((e.opening + e.postings) * 100) / 100;
      };
      if (from && mm && mm.opening) for (const ln of all) if (mm.opening[ln]) { op += -mm.opening[ln]; each(ln, 'opening', -mm.opening[ln]); }
      const match = { branch: br, ...LIVE_ONLY };
      if (from) match.date = { $gte: from };
      // A balance is struck ON A DAY, and Tally strikes it today. A voucher dated
      // ahead -- a post-dated cheque, a sale entered for next week -- is in the books
      // but not in today's balance, and adding it here makes a party look owing money
      // it has not been billed for yet. Split rather than dropped: money that IS coming
      // is worth seeing, it just is not outstanding today.
      const rows2 = await db.collection('vouchers').aggregate([
        { $match: match },
        { $project: { date: 1, kv: { $concatArrays: [
          { $objectToArray: { $ifNull: ['$party_ledgers', {}] } },
          { $objectToArray: { $ifNull: ['$ledgers', {}] } }] } } },
        { $unwind: '$kv' },
        { $match: { 'kv.k': { $in: [...all] } } },
        { $group: { _id: { k: '$kv.k', d: '$date' }, sum: { $sum: '$kv.v' } } },
      ], { allowDiskUse: true }).toArray();
      // By ledger AND by month. When a ledger disagrees with Tally, the month it starts
      // disagreeing in is the whole search: Tally's own ledger report opens on a monthly
      // summary, so the two columns can be read side by side and the argument is down to
      // one month before anybody opens a voucher.
      let la = 0;
      for (const r of rows2) {
        const ln = r._id.k, dt = String(r._id.d || ''), amt = -r.sum;
        if (dt > upTo) { la += amt; each(ln, 'later', amt); continue; }
        po += amt; each(ln, 'postings', amt);
        const mk = dt.slice(0, 6);
        const m = balance.byMonth[ln] || (balance.byMonth[ln] = {});
        m[mk] = Math.round(((m[mk] || 0) + amt) * 100) / 100;
      }
      const r2 = (n) => Math.round(n * 100) / 100;
      balance.later = r2(balance.later + la);
      balance.byBranch[br] = { openingAsOn: from, opening: r2(op), postings: r2(po), total: r2(op + po), later: r2(la) };
      balance.opening = r2(balance.opening + op);
      balance.postings = r2(balance.postings + po);
      balance.total = r2(balance.total + op + po);
      if (from && (!balance.asOn || from < balance.asOn)) balance.asOn = from;
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
      ledgers, matched: matches.length, stored, truncated, vouchers, bills, balance,
      // Every ledger in the books that no master defines, not just the searched one.
      // One is a curiosity; the count and the money say whether it is a habit worth
      // a merge session. The list is the ten that carry the most.
      unknownLedgers: {
        count: orphans.size,
        amount: Math.round([...orphans.values()].reduce((a, o) => a + o.amount, 0) * 100) / 100,
        // All of them, not a top ten: this list is worked through in one sitting, and a
        // merge session that can only see the ten biggest leaves the rest for next time.
        worst: [...orphans.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 200),
      },
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

    const match = { date: { $gte: from, $lte: to }, ...LIVE_ONLY };
    if (branch !== 'all') match.branch = branch;
    const db = await getDb();
    // Every spelling merged into this name, because the vouchers keep whatever was
    // typed at the time. EXCEPT when the caller is holding one ledger's own report out
    // of Tally: Tally is asked one ledger at a time, so our sum of three spellings put
    // beside its one is a discrepancy that is not there.
    const exact = String(req.query.exact || '') === '1';
    const names = exact ? [ledger] : aliasVariants(await readAliasMap(db), ledger);
    const rows = await db.collection('vouchers').aggregate([
      { $match: match },
      { $addFields: { _k: { $concatArrays: [
        { $map: { input: { $objectToArray: { $ifNull: ['$ledgers', {}] } }, in: '$$this.k' } },
        { $map: { input: { $objectToArray: { $ifNull: ['$party_ledgers', {}] } }, in: '$$this.k' } },
      ] } } },
      { $match: { _k: { $in: names } } },
      { $sort: { date: 1 } },
      { $limit: limit + 1 },
      // Same correction as /api/capex: narration is details.narration, so asking for a
      // top-level `narration` returned blank for every voucher this endpoint has served.
      { $project: { _id: 0, branch: 1, date: 1, no: 1, type: 1, party: 1, guid: 1,
        narration: '$details.narration', ledgers: 1, party_ledgers: 1 } },
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
    res.json({ ledger, branch, from, to, names, exact, count: rows.length, truncated, vouchers: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/loans?branch=all|kol|ahm&from=YYYYMMDD&to=YYYYMMDD&bucket=day|week|month
// Opening, drawdowns, repayments and closing for every borrowing account -- secured and
// unsecured loans, OD/CC, packing credit, PCFC, bill discounting, term loans -- as a
// running statement where each period's closing is the next one's opening.
//
// Cr-POSITIVE throughout: a loan outstanding is a POSITIVE number, `drawn` adds to it,
// `repaid` subtracts. The receivables code is Dr-positive; a loan report on that scale
// reads "outstanding: -1,62,00,000" and gets misread, so it is flipped here and said so
// in the response.
//
// Both ledger maps are read. A packing credit sits under Bank OD A/c, which the
// extractor files under `party_ledgers`, while a secured loan lands in `ledgers` --
// looking in only one of them is how PCFC accounts stayed invisible for a year.
//
// The arithmetic is in loanMovement.js and has no database in it; this is the adapter.
app.get('/api/loans', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const bucket = ['day', 'week', 'month'].includes(String(req.query.bucket)) ? String(req.query.bucket) : 'month';
    const from = DATE8.test(String(req.query.from || '')) ? String(req.query.from) : null;
    const to = DATE8.test(String(req.query.to || '')) ? String(req.query.to) : null;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to are required as YYYYMMDD' });
    if (to < from) return res.status(400).json({ ok: false, error: `to (${to}) is before from (${from})` });
    // A day-by-day statement over a decade is 3,650 columns nobody reads and a response
    // nobody can hold. The cap names itself so the caller can widen the bucket instead.
    const span = LM.bucketsBetween(from, to, bucket).length;
    if (span > 800) {
      return res.status(400).json({ ok: false,
        error: `${span} ${bucket} periods is too many to return at once (max 800). Use bucket=week or bucket=month, or a shorter window.` });
    }

    const db = await getDb();
    const branches = branch === 'all' ? ['kol', 'ahm'] : [branch];
    const aliases = await readAliasMap(db);

    // EACH COMPANY IS CLASSIFIED BY ITS OWN MASTER, AND A LOAN IS KEYED BY BRANCH.
    // The merged hierarchy is Kolkata-first, so a ledger NAME that is a Bank OD in
    // Kolkata and something else entirely in Ahmedabad reads as a loan for both -- and
    // this endpoint then took Ahmedabad's opening and Ahmedabad's postings for that name
    // as loan figures. Tally's own report shows what that cost: Kolkata has
    // "Citi Bank, (Kolkata)" opening 6.36 Cr and Ahmedabad has "Citi Bank, (Ahmedabad)"
    // opening 1.41 L, two different accounts -- while this page showed ONE row carrying a
    // phantom 39.35 Cr, which is what Ahmedabad's same-named ledger holds OUTSIDE its
    // loan group. Tally reports each company separately for exactly this reason.
    //
    // So: classify per branch from that branch's own groups, and key every loan
    // `branch|ledger`. A facility recorded in both companies is then two rows that add
    // up, which is what consolidation means, instead of one row that may be a double
    // count or a collision and nobody can tell which.
    const ledgerMeta = {};                   // 'br|ledger' -> meta
    const nearMisses = [];
    let interestLike = 0;      // named like a loan, but interest/insurance: never a borrowing
    const perBranch = {};
    for (const br of branches) {
      const mb = readMaster(await db.collection('masters').findOne({ branch: br }));
      const xdb = mb || { ledgers: {}, groups: {}, ids: {} };
      const lub = E.buildLookups(xdb);
      const nameOf = {};                     // raw voucher name -> 'br|ledger'
      for (const ln of Object.keys(xdb.ledgers || {})) {
        const chain = E.getChain(ln, xdb, lub);
        const kind = LM.loanKind(ln, chain);
        const key = br + '|' + ln;
        if (kind) {
          ledgerMeta[key] = { kind, group: chain.join(' > '), name: ln, branch: br, branches: [br] };
          // The vouchers keep whatever name was typed, so an account renamed in Tally is
          // asked for under every spelling merged into it -- scoped to this branch, so a
          // merge saved for a party cannot weld two companies' bank accounts together.
          for (const v of aliasVariants(aliases, ln)) nameOf[v] = key;
        } else if (LM.nearMiss(ln, chain)) {
          nearMisses.push({ ledger: ln, branch: br, group: chain.join(' > ') });
        } else if (LM.notBorrowingByName(ln)
          && (chain.join('>').toLowerCase().indexOf('loan') >= 0 || /loan|od|overdraft|pcfc|pcre/i.test(ln))) {
          interestLike++;
        }
      }
      perBranch[br] = { master: mb, nameOf, wanted: Object.keys(nameOf) };
    }
    const wanted = Object.keys(ledgerMeta);

    if (!wanted.length) {
      return res.json({ ok: true, branch, bucket, from, to, scale: 'cr-positive',
        loans: [], periods: [], byKind: [], total: { opening: 0, drawn: 0, repaid: 0, closing: 0 },
        nearMisses,
        note: 'No ledger in either company sits under a loan group (Secured Loans, Unsecured Loans, Bank OD/OCC, Loans (Liability)). Either nothing is borrowed, or the masters have not been pulled -- /api/meta says which.' });
    }

    // The openings Tally itself carries, on the day they stand. Cr-positive, so they are
    // taken as stored: `masters.opening` is Tally-raw, where a liability is +ve.
    const openings = {};
    const closings = {};
    for (const br of branches) {
      const mm = perBranch[br].master;
      const nameOf = perBranch[br].nameOf;
      const seen = [...new Set([].concat(mm ? mm.openingAsOn : []).map((x) => String(x || '')))];
      const asOn = (seen.length === 1 && DATE8.test(seen[0])) ? seen[0] : null;
      const amounts = {};
      if (asOn && mm && mm.opening) {
        for (const raw of Object.keys(mm.opening)) {
          const canon = nameOf[raw];
          if (canon && mm.opening[raw]) amounts[canon] = (amounts[canon] || 0) + mm.opening[raw];
        }
      }
      openings[br] = { asOn, amounts };
      // Tally's OWN closing balance, as at the day it was asked for. This is what makes
      // the page self-checking: our opening plus every posting we hold must land on it,
      // per account, with nothing to reconcile by hand. Only arrives once the pipeline
      // has been re-run with the dated openings request.
      const cAsOn = (mm && DATE8.test(String(mm.closingAsOn || ''))) ? String(mm.closingAsOn) : null;
      const cAmt = {};
      if (cAsOn && mm.closing) {
        for (const raw of Object.keys(mm.closing)) {
          const canon = nameOf[raw];
          if (canon && mm.closing[raw]) cAmt[canon] = (cAmt[canon] || 0) + mm.closing[raw];
        }
      }
      closings[br] = { asOn: cAsOn, amounts: cAmt };
    }

    // Rows must reach back to whichever is earlier: the window start, or the day the
    // openings stand on. Both directions matter -- see buildLoanMovement.
    let queryFrom = from;
    for (const br of branches) {
      const a = openings[br].asOn;
      if (a && a < queryFrom) queryFrom = a;
    }
    // ONE QUERY PER BRANCH, each asking only for the names that are loans in THAT
    // company. A single query over both would have to accept a name that is a loan in
    // either, which is the collision this endpoint exists to have stopped making.
    const rows = [];
    for (const br of branches) {
      const want = perBranch[br].wanted;
      if (!want.length) continue;
      const nameOf = perBranch[br].nameOf;
      const raw = await db.collection('vouchers').aggregate([
        { $match: { branch: br, date: { $gte: queryFrom, $lte: to }, ...LIVE_ONLY } },
        { $project: { branch: 1, date: 1, kv: { $concatArrays: [
          { $objectToArray: { $ifNull: ['$party_ledgers', {}] } },
          { $objectToArray: { $ifNull: ['$ledgers', {}] } }] } } },
        { $unwind: '$kv' },
        { $match: { 'kv.k': { $in: want } } },
        { $group: { _id: { k: '$kv.k', d: '$date' },
          // +ve = Cr = borrowed; -ve = Dr = repaid. Kept apart rather than netted, or a
          // drawdown and a repayment on the same day would cancel and both would vanish
          // from a report whose whole subject is the two of them.
          drawn: { $sum: { $cond: [{ $gt: ['$kv.v', 0] }, '$kv.v', 0] } },
          repaid: { $sum: { $cond: [{ $lt: ['$kv.v', 0] }, { $multiply: ['$kv.v', -1] }, 0] } } } },
      ], { allowDiskUse: true }).toArray();
      for (const r of raw) {
        const key = nameOf[r._id.k];
        if (!key) continue;
        rows.push({ ledger: key, branch: br, date: String(r._id.d || ''),
          drawn: r.drawn || 0, repaid: r.repaid || 0 });
      }
    }

    const out = LM.buildLoanMovement({ ledgerMeta, openings, closings, rows, from, to, bucket });
    // What the figures do and do not rest on, said rather than assumed. A branch whose
    // openings never arrived gives movement, not a balance, and that has to be on the
    // page and not in a comment here.
    const notes = [];
    for (const br of branches) {
      if (!openings[br].asOn) {
        notes.push(`${br}: Tally's opening balances have not been pulled (or the day they stand on is ambiguous), so the opening shown is the movement held before ${from}, not a balance. Run the pipeline once and ask again.`);
      }
    }
    // THE OPENING MUST NOT PREDATE THE VOUCHERS. A balance here is Tally's opening on
    // its own day plus every posting since, so if the oldest voucher we hold is NEWER
    // than that day, the postings in between are in neither half and the balance is
    // wrong by exactly whatever happened in them. On a sweeping OD, where hundreds of
    // crores move each way per year, that is the difference between a usable figure and
    // a meaningless one -- and it is silent, because every row still adds up.
    // The same check the party-balance reading makes; it belongs here more, not less.
    const firstOf = {};
    for (const br of branches) {
      const f = await db.collection('vouchers').find({ branch: br }).sort({ date: 1 }).limit(1).toArray();
      firstOf[br] = f.length ? f[0].date : null;
      const asOn = openings[br].asOn;
      if (asOn && firstOf[br] && firstOf[br] > asOn) {
        // How WIDE the gap is decides whether it can explain anything, so it is counted
        // rather than left to be eyeballed off two dates. And a day on which nothing was
        // posted leaves nothing out -- the guard cannot tell an empty day from a missing
        // one, so it must not claim the balances are wrong, only that this much is
        // unaccounted for. Overstating it is how a page stops being believed.
        const days = Math.max(1, Math.round((Date.UTC(+firstOf[br].slice(0, 4), +firstOf[br].slice(4, 6) - 1, +firstOf[br].slice(6, 8))
          - Date.UTC(+asOn.slice(0, 4), +asOn.slice(4, 6) - 1, +asOn.slice(6, 8))) / 86400000));
        const scale = days <= 3
          ? `That is ${days} day(s). If nothing was posted in them this is fine and changes no figure here; if something was, it is missing from every balance below.`
          : `That is ${days} days of postings in neither half, so every balance below is out by whatever happened in them -- and on an OD or CC account that can be the whole difference, because a sweeping account is paid down by postings we do not hold.`;
        // THE CROSS-CHECK ALREADY ANSWERS THIS. If every account with a Tally closing
        // balance comes out at that figure here, then opening-plus-postings reconstructs
        // the books end to end and whatever happened in the gap changed nothing. Repeating
        // the warning anyway, under a green "checked against Tally" verdict, teaches the
        // reader to skip both. It is reported, but as a settled question.
        const tc = out.tallyCheck || {};
        const proven = tc.compared >= 5 && tc.agree === tc.compared;
        notes.push(proven
          ? `${br}: the opening balances stand on ${asOn} and the oldest ${br} voucher held is ${firstOf[br]}, a ${days}-day gap -- but all ${tc.compared} account(s) still reconcile to Tally's own closing balance, so nothing was posted in it that moves a figure here. Back-filling ${br} (pipeline: -From ${asOn} -To ${firstOf[br]}) would close the gap on paper; no number below depends on it.`
          : `${br}: the opening balances stand on ${asOn} but the OLDEST ${br} voucher held is ${firstOf[br]}. ${scale} Settle it by back-filling ${br} (pipeline: -From ${asOn} -To ${firstOf[br]}), which is cheap and removes the question.`);
      }
    }
    if (nearMisses.length) {
      notes.push(`${nearMisses.length} ledger(s) are NAMED like a borrowing but are not under a loan group, so they are NOT counted: ${nearMisses.slice(0, 8).map((x) => `"${x.ledger}" (${x.group})`).join(', ')}. If one of those is a real loan, move it under a loan group in Tally or tell us.`);
    }
    if (interestLike) {
      notes.push(`${interestLike} interest, insurance and subvention ledger(s) name a loan ("Interest on Term Loan with HDFC Bank") and are left out as a matter of course -- interest owed is not money borrowed. They are not listed, and nothing needs doing about them.`);
    }
    res.json({ ok: true, branch, scale: 'cr-positive',
      scaleNote: 'A loan outstanding is POSITIVE. drawn = borrowed (Cr), repaid = paid back (Dr). closing = opening + drawn - repaid.',
      ...out, nearMisses, notes, firstVoucher: firstOf });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/capex?branch=all|kol|ahm&from=YYYYMMDD&to=YYYYMMDD&min=0
// What was spent on fixed assets: every posting that DEBITS a Fixed Asset (or capital
// work in progress) ledger, as a dated list -- what was bought, when, for how much, on
// which voucher, and from whom.
//
// THE ASSET LEG, NOT THE PAYMENT. An addition is recorded the day the asset is
// capitalised; the money may have left earlier (advance) or not yet (creditor, or a term
// loan drawn against the machine). So each row also says HOW IT WAS FUNDED, read off the
// same voucher's other legs: paid from bank or cash, taken on credit, or financed by a
// loan. "Capex in terms of cash flow" without that distinction reads a machine bought on
// five-year finance as five crores of cash gone in a day.
//
// Credits to the same ledgers are disposals and are kept apart rather than netted: a year
// that bought 2 Cr and sold 1 Cr of plant is not a year that spent 1 Cr.
// A GROUP NAME CAN CONTAIN "FIXED ASSETS" WITHOUT BEING ONE, and testing the whole chain
// as one string is how this report counted the same machine four times. Kolkata files the
// suppliers of its machines under `Current Liabilities > Sundry Creditors > Sundry Creditor
// - Fixed Assets`. A substring test over the joined chain made every one of those creditors
// a fixed asset, so ONE purchase produced: the real asset leg; the creditor leg, which is a
// CREDIT and therefore read as a disposal of the same amount; the bank payment that settled
// it months later, read as a second purchase "financed by a loan" because the OD was the
// other leg; and the exchange difference on it. The totals then counted a 21 L printer as
// roughly 42 L of additions and 21 L of disposals, and the entry list showed the supplier's
// name in the Item column.
//
// What decides it is where the chain ROOTS. Walking it top-down, a payables / receivables /
// bank group reached BEFORE any fixed-asset group means everything below it is that group's
// business, whatever the sub-group is called. Anything dropped this way is reported in
// `excludedGroups` rather than silently vanishing: a real asset group filed somewhere
// unusual must be visible on the page, not discovered a year later.
const BLOCKS_ASSET = ['sundry creditors', 'sundry debtors', 'current liabilities',
  'current assets', 'loans (liability)', 'secured loans', 'unsecured loans',
  'bank od', 'bank occ', 'bank accounts', 'cash-in-hand', 'cash in hand',
  'duties & taxes', 'provisions', 'branch / divisions', 'loans & advances',
  'liability for expenses'];
const MENTIONS_ASSET = ['fixed assets', 'capital work', 'capital-work'];
// The accounts capex money passes through on its way out: the creditor a machine is
// booked against, and the advance paid before it ships. Recognised by the group Tally
// files them in -- Kolkata's is literally `Sundry Creditor - Fixed Assets` -- or by an
// advance account that names capital goods. Deliberately narrow: a general
// "Advance to Suppliers" holding both paper and machinery cannot be split by any rule
// here, and guessing would put raw-material money in a capex figure. What it DID match
// is returned in `capexPartyGroups` and listed on the page, so it can be corrected.
// NEVER MATCH BARE 'capital': `Capital Account` is the ROOT of every group chain in
// Tally, so it would make every ledger in the company a capex account.
// 'machinary' is in the list because that is how the Ahmedabad masters spell it.
const CAPITAL_KW = ['fixed asset', 'capital goods', 'capital work', 'capital expenditure',
  'capital advance', 'capex', 'machinery', 'machinary', 'machine', 'equipment',
  'plant &', 'plant and'];
function hasCapitalWord(hay) { for (const k of CAPITAL_KW) if (hay.indexOf(k) >= 0) return true; return false; }
function capexPartyKind(name, chain) {
  const cs = (Array.isArray(chain) ? chain.join('>') : String(chain || '')).toLowerCase();
  const nm = String(name || '').toLowerCase();
  // AN ADVANCE is recognised from the group OR the ledger name, because it is filed both
  // ways -- a group called `Advance for Machinery` holding one ledger per supplier, or a
  // ledger called `Advance - Heidelberg Machine` under a general advances group. Requiring
  // the exact words `plant & machinery` missed `Advance for Machinery` entirely, and with
  // it every rupee paid against a proforma -- which on these books is nearly all of the
  // capex cash, since the machine is paid for long before any creditor is touched.
  if ((cs + '>' + nm).indexOf('advance') >= 0 && hasCapitalWord(cs + '>' + nm)) return 'advance';
  // A CREDITOR is recognised from the GROUP only. The ledger name here is a company's
  // name, and matching on it would make "Machine Oil Suppliers" under ordinary Sundry
  // Creditors a capex account; the signal is a group kept for machinery suppliers.
  if ((cs.indexOf('sundry creditors') >= 0 || cs.indexOf('current liabilities') >= 0)
    && hasCapitalWord(cs)) return 'capital_creditor';
  return null;
}
const BANKISH = ['bank accounts', 'cash-in-hand', 'cash in hand', 'bank od', 'bank occ'];
function isBankish(cs) { for (const b of BANKISH) if (String(cs || '').indexOf(b) >= 0) return true; return false; }


function assetDepth(chain) {
  const segs = Array.isArray(chain) ? chain : String(chain || '').split('>');
  for (let i = 0; i < segs.length; i++) {
    const seg = String(segs[i]).toLowerCase();
    for (const b of BLOCKS_ASSET) if (seg.indexOf(b) >= 0) return -1;
    for (const a of MENTIONS_ASSET) if (seg.indexOf(a) >= 0) return i;
  }
  return -1;
}

app.get('/api/capex', async (req, res) => {
  try {
    const branch = ['all', 'kol', 'ahm'].includes(String(req.query.branch)) ? String(req.query.branch) : 'all';
    const from = DATE8.test(String(req.query.from || '')) ? String(req.query.from) : null;
    const to = DATE8.test(String(req.query.to || '')) ? String(req.query.to) : null;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to are required as YYYYMMDD' });
    if (to < from) return res.status(400).json({ ok: false, error: `to (${to}) is before from (${from})` });
    const min = Math.max(0, Number(req.query.min) || 0);

    const db = await getDb();
    const branches = branch === 'all' ? ['kol', 'ahm'] : [branch];
    // Per branch from its OWN master, for the same reason the loan page does it: one
    // ledger name can be a fixed asset in one company and something else in the other.
    const assetOf = {};                      // br -> { ledger: group }
    const chainOf = {};                      // br -> { ledger: lowercased chain, for matching }
    const dispOf = {};                       // br -> { ledger: chain as Tally spells it }
    const excluded = new Map();              // group chain -> how many ledgers it holds
    for (const br of branches) {
      const mb = readMaster(await db.collection('masters').findOne({ branch: br }));
      const xdb = mb || { ledgers: {}, groups: {}, ids: {} };
      const lub = E.buildLookups(xdb);
      const map = {};
      const chains = {};
      const disp = {};
      for (const ln of Object.keys(xdb.ledgers || {})) {
        const chain = E.getChain(ln, xdb, lub);
        const cs = chain.join('>').toLowerCase();
        chains[ln] = cs;
        disp[ln] = chain.join(' > ');
        // Fixed Assets, plus capital work in progress wherever it is filed. Depreciation
        // is an expense and sits under Indirect Expenses, so it never reaches here; an
        // accumulated-depreciation ledger filed UNDER Fixed Assets is excluded by name,
        // because writing an asset down is not buying one.
        const depth = assetDepth(chain);
        if (depth < 0) {
          // Named like an asset group but filed under a liability: worth reporting, not
          // worth counting. See assetDepth.
          if (MENTIONS_ASSET.some((a) => cs.indexOf(a) >= 0)) {
            const k = br + '|' + chain.join(' > ');
            excluded.set(k, (excluded.get(k) || 0) + 1);
          }
          continue;
        }
        const nm = ln.toLowerCase();
        if (nm.indexOf('depreciation') >= 0 || nm.indexOf('depriciation') >= 0
          || nm.indexOf('amorti') >= 0) continue;
        map[ln] = chain.join(' > ');
      }
      assetOf[br] = map;
      chainOf[br] = chains;
      dispOf[br] = disp;
    }
    // CASH OUT ON CAPEX DOES NOT PASS THROUGH THE ASSET LEDGER. A machine is paid for
    // long before it is capitalised -- an advance against a proforma, then the balance to
    // the supplier -- and both of those touch a CREDITOR or an ADVANCE account, never the
    // fixed asset. So the money is followed through those instead, and the two kinds are
    // kept apart because an advance is cash gone on a machine that has not arrived.
    const partyOf = {};                      // br -> { ledger: {kind, group} }
    const partyGroups = new Map();
    const advGroups = new Map();             // every group saying "advance", counted or not
    for (const br of branches) {
      const chains = chainOf[br] || {};
      const amap = assetOf[br] || {};
      const pm = {};
      for (const ln of Object.keys(chains)) {
        if (amap[ln]) continue;              // the asset itself, already counted
        const kind = capexPartyKind(ln, chains[ln]);
        if (!kind) continue;
        pm[ln] = { kind, group: (dispOf[br] || {})[ln] || chains[ln] };
        const k = br + '|' + kind + '|' + pm[ln].group;
        partyGroups.set(k, (partyGroups.get(k) || 0) + 1);
      }
      partyOf[br] = pm;
      for (const ln of Object.keys(chains)) {
        if (amap[ln]) continue;
        if (chains[ln].indexOf('advance') < 0 && String(ln).toLowerCase().indexOf('advance') < 0) continue;
        const g = (dispOf[br] || {})[ln] || chains[ln];
        const k = br + '|' + g;
        const e = advGroups.get(k) || { branch: br, group: g, ledgers: 0, counted: false };
        e.ledgers++; if (pm[ln]) e.counted = true;
        advGroups.set(k, e);
      }
    }
    const capexPartyGroups = [...partyGroups.entries()]
      .map(([k, n]) => { const p = k.split('|'); return { branch: p[0], kind: p[1], group: p.slice(2).join('|'), ledgers: n }; })
      .sort((a, b) => b.ledgers - a.ledgers);
    const advanceGroups = [...advGroups.values()].sort((a, b) => b.ledgers - a.ledgers);

    const excludedGroups = [...excluded.entries()]
      .map(([k, n]) => ({ branch: k.split('|')[0], group: k.slice(k.indexOf('|') + 1), ledgers: n }))
      .sort((a, b) => b.ledgers - a.ledgers);
    const anyAssets = branches.some((br) => Object.keys(assetOf[br]).length);
    if (!anyAssets) {
      return res.json({ ok: true, branch, from, to, rows: [], additions: 0, disposals: 0, net: 0,
        byGroup: [], byMonth: [], byFunding: [],
        note: 'No ledger in either company sits under Fixed Assets. Either nothing is capitalised there, or the masters have not been pulled -- /api/meta says which.' });
    }

    const match = { date: { $gte: from, $lte: to }, ...LIVE_ONLY };
    if (branch !== 'all') match.branch = branch;
    const vs = await db.collection('vouchers').find(match)
      // NARRATION IS NOT A TOP-LEVEL FIELD. The extractor puts it inside `details`
      // (details.narration), so projecting `narration: 1` asks for a field no voucher
      // has and every row comes back blank -- which is exactly how it shipped.
      .project({ _id: 0, branch: 1, date: 1, no: 1, type: 1, party: 1, guid: 1,
        'details.narration': 1, 'details.reference': 1, 'details.partyName': 1,
        ledgers: 1, party_ledgers: 1, bills: 1 })
      .toArray();

    // How the voucher paid for it, from its own other legs. Named rather than guessed:
    // the order matters, because a machine bought on a term loan usually also touches a
    // creditor, and the loan is the thing worth knowing.
    const FUND = [
      { kw: ['secured loans', 'unsecured loans', 'bank od', 'bank occ', 'loans (liability)'], as: 'loan' },
      { kw: ['sundry creditors'], as: 'credit' },
      { kw: ['bank accounts', 'cash-in-hand', 'cash in hand'], as: 'cash' },
    ];
    const rows = [];
    const cashRows = [];
    let additions = 0, disposals = 0, movedTotal = 0, cashOut = 0, unmatchedSupplier = 0;
    // A LEDGER THAT SUPPLIED A MACHINE IS A MACHINERY SUPPLIER, whatever its group is
    // called. Names and groups only go so far: Ahmedabad's advances sit under `Advance
    // for Machinery` and Kolkata's creditors under `Sundry Creditor - Fixed Assets`, but
    // a company that files neither would have its payments silently missing. So the
    // purchases themselves are read first, and every ledger CREDITED on a voucher that
    // DEBITS a fixed asset is taken as a supplier of that asset -- evidence rather than
    // vocabulary. Collected here, used by the cash pass below.
    const seenSupplier = {};                 // 'br|ledger' -> group, learned from purchases
    const capexBill = {};                    // 'br|ledger|ref' -> true, the bills assets were bought on
    for (const v of vs) {
      const map = assetOf[v.branch] || {};
      const chs = chainOf[v.branch] || {};
      const dsp = dispOf[v.branch] || {};
      const all = Object.assign({}, v.party_ledgers || {}, v.ledgers || {});
      const hits = Object.keys(all).filter((k) => map[k] && Math.abs(all[k]) >= 1);
      if (!hits.length) continue;
      let assetDrHere = 0;
      for (const ln of hits) if (all[ln] < 0) assetDrHere -= all[ln];
      if (assetDrHere < 1) continue;         // nothing was bought on this voucher
      for (const k of Object.keys(all)) {
        if (map[k] || all[k] <= 0) continue;              // not a credit, or the asset itself
        const c = chs[k] || '';
        // Only a payable. A loan or a bank leg funds the purchase; it does not supply it.
        if (c.indexOf('sundry creditors') < 0 && c.indexOf('sundry debtors') < 0) continue;
        seenSupplier[v.branch + '|' + k] = dsp[k] || c;
      }
      // AND THE BILL ITSELF. "This party once sold us an asset" is far too wide a net:
      // a freight forwarder whose charges on ONE import were capitalised into a machine
      // then had its every routine invoice counted as capex -- ten ordinary payments,
      // 1.76 Cr, none of it capital. A bill reference is exact where a party is not, so
      // the refs raised on this voucher are remembered and only payments against THOSE
      // count later.
      for (const b of (v.bills || [])) {
        if (!b || !b.ref || map[b.ledger]) continue;
        if (!seenSupplier[v.branch + '|' + b.ledger]) continue;
        capexBill[v.branch + '|' + b.ledger + '|' + String(b.ref).trim().toLowerCase()] = true;
      }
    }

    for (const v of vs) {
      const map = assetOf[v.branch] || {};
      const pm = partyOf[v.branch] || {};
      const chs = chainOf[v.branch] || {};
      const all = Object.assign({}, v.party_ledgers || {}, v.ledgers || {});

      // ---- WHAT LEFT THE BANK BECAUSE OF CAPEX --------------------------------
      // Followed on the PAYMENT voucher, not the capitalisation. A bank or cash ledger
      // CREDITED is money going out (Tally +ve); the capex share of it is whatever that
      // voucher DEBITED to an asset, to a machinery creditor, or to a capital advance.
      // Taking the debits rather than the bank total is what makes a payment run that
      // settles one machine and three paper bills contribute only the machine.
      let bankOut = 0;
      for (const k of Object.keys(all)) if (isBankish(chs[k])) bankOut += all[k];
      if (Math.abs(bankOut) >= 1) {
        let capexDr = 0; const legs = [];
        for (const k of Object.keys(all)) {
          const kind = map[k] ? 'asset'
            : ((pm[k] && pm[k].kind) || (seenSupplier[v.branch + '|' + k] ? 'supplier' : null));
          if (!kind) continue;
          let dr = -all[k];                       // Dr positive: money applied to capex
          // SELLING AN ASSET IS NOT NEGATIVE CAPEX SPEND. Proceeds from scrapping old
          // laptops came back here as cash out of -3,00,000, quietly netting a disposal
          // into the spend figure -- the one thing this page refuses to do anywhere
          // else. An asset leg counts only when it is DEBITED. A creditor or an advance
          // counts both ways, because money genuinely coming BACK from a machinery
          // supplier is a refund of capex cash and belongs in the figure.
          if (kind === 'asset' && dr <= 0) continue;
          // A GROUP kept for machinery says every rupee through it is capital. A party
          // recognised only because it once supplied an asset says no such thing -- so
          // it counts only to the extent this payment settles a bill the asset was
          // actually bought on. A payment that names no such bill is an ordinary one.
          if (kind === 'supplier') {
            let matched = 0;
            for (const b of (v.bills || [])) {
              if (!b || b.ledger !== k || !b.ref) continue;
              if (!capexBill[v.branch + '|' + k + '|' + String(b.ref).trim().toLowerCase()]) continue;
              matched += Math.abs(Number(b.amount) || 0);
            }
            const skipped = Math.max(0, dr - matched);
            if (skipped >= 1) unmatchedSupplier = Math.round((unmatchedSupplier + skipped) * 100) / 100;
            dr = Math.min(dr, matched);
            if (dr < 1) continue;
          }
          capexDr += dr;
          legs.push({ ledger: k, kind, amt: dr });
        }
        // Both sides must point the same way. Money out against a capex debit is a
        // payment; money IN against a capex credit is a refund and is counted negative.
        // Anything else (a receipt that happens to touch an asset) is not capex cash.
        let attr = 0;
        if (capexDr > 0 && bankOut > 0) attr = Math.min(capexDr, bankOut);
        else if (capexDr < 0 && bankOut < 0) attr = Math.max(capexDr, bankOut);
        if (Math.abs(attr) >= 1) {
          legs.sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt));
          const lead = legs[0];
          cashOut = Math.round((cashOut + attr) * 100) / 100;
          cashRows.push({ date: v.date, branch: v.branch,
            amount: Math.round(attr * 100) / 100,
            paidFor: lead.ledger, kind: lead.kind,
            alsoLegs: legs.length - 1,
            no: v.no || '', type: v.type || '',
            party: v.party || ((v.details || {}).partyName) || '',
            narration: (((v.details || {}).narration) || '').slice(0, 300),
            guid: v.guid || '' });
        }
      }

      const hits = Object.keys(all).filter((k) => map[k] && Math.abs(all[k]) >= 1);
      if (!hits.length) continue;
      // How the ENTRY WAS BOOKED -- which says nothing about when the money moved. See
      // FUND below.
      let funded = 'other';
      const chains = chs;
      const others = Object.keys(all).filter((k) => !map[k]);
      outer:
      for (const f of FUND) {
        for (const o of others) {
          const c = chains[o] || '';
          for (const kw of f.kw) if (c.indexOf(kw) >= 0) { funded = f.as; break outer; }
        }
      }
      // MONEY MOVING BETWEEN TWO ASSET ACCOUNTS IS NEITHER A PURCHASE NOR A SALE.
      // When the Ahmedabad factory was finished, one journal credited every
      // work-in-progress ledger it had been accumulated in and debited the finished
      // asset. Read leg by leg that is a 44 Cr "disposal" of machines nobody sold, and
      // the same 44 Cr counted a SECOND time as assets bought -- the building and every
      // machine in it appeared twice, once as WIP and once as itself.
      //
      // So the asset legs of a voucher are weighed against each other first: whatever is
      // debited to one asset and credited from another is a TRANSFER, and only the excess
      // on either side is a real purchase or a real disposal. A journal that capitalises
      // WIP balances exactly nets to nothing, which is the correct answer -- the company
      // owns what it already owned, under a different name.
      let drTot = 0, crTot = 0;
      for (const ln of hits) { const a = all[ln]; if (a < 0) drTot -= a; else crTot += a; }
      const internal = Math.min(drTot, crTot);
      const drKeep = drTot > 0 ? (drTot - internal) / drTot : 0;
      const crKeep = crTot > 0 ? (crTot - internal) / crTot : 0;
      for (const ln of hits) {
        const amt = all[ln];
        // -ve = Dr = the asset went UP: that is the purchase. +ve = Cr = a disposal.
        const gross = Math.abs(amt);
        const keep = amt < 0 ? drKeep : crKeep;
        const spend = amt < 0 ? gross * keep : 0;
        const sold = amt > 0 ? gross * keep : 0;
        const moved = Math.round(gross * (1 - keep) * 100) / 100;
        if (spend && spend < min) continue;
        if (spend) additions = Math.round((additions + spend) * 100) / 100;
        if (sold) disposals = Math.round((disposals + sold) * 100) / 100;
        if (moved) movedTotal = Math.round((movedTotal + moved) * 100) / 100;
        rows.push({ date: v.date, branch: v.branch, asset: ln, group: map[ln],
          spend: Math.round(spend * 100) / 100, disposal: Math.round(sold * 100) / 100,
          moved, movedOut: moved ? (amt > 0) : false,
          no: v.no || '', type: v.type || '',
          party: v.party || ((v.details || {}).partyName) || '',
          narration: (((v.details || {}).narration) || '').slice(0, 300),
          reference: ((v.details || {}).reference) || '',
          guid: v.guid || '',
          funded: spend ? funded : (sold ? 'disposal' : 'moved') });
      }
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
      || (b.spend - a.spend) || a.asset.localeCompare(b.asset));

    const roll = (keyOf, labelOf) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        const e = m.get(k) || { key: k, label: labelOf(r), spend: 0, disposal: 0, count: 0 };
        e.spend = Math.round((e.spend + r.spend) * 100) / 100;
        e.disposal = Math.round((e.disposal + r.disposal) * 100) / 100;
        if (r.spend) e.count++;
        m.set(k, e);
      }
      return [...m.values()];
    };
    const byGroup = roll((r) => r.group, (r) => r.group).sort((a, b) => b.spend - a.spend);
    const byMonth = roll((r) => r.date.slice(0, 6), (r) => LM.bucketLabel(r.date.slice(0, 6), 'month'))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const byAsset = roll((r) => r.branch + '|' + r.asset, (r) => r.asset).sort((a, b) => b.spend - a.spend);
    const byFunding = roll((r) => r.funded, (r) => r.funded)
      .filter((x) => x.key !== 'moved').sort((a, b) => b.spend - a.spend);

    const supG = new Map();
    for (const k of Object.keys(seenSupplier)) {
      const br = k.slice(0, k.indexOf('|'));
      const kk = br + '|supplier|' + seenSupplier[k];
      supG.set(kk, (supG.get(kk) || 0) + 1);
    }
    for (const [k, n] of supG.entries()) {
      const p = k.split('|');
      const g = p.slice(2).join('|');
      if (capexPartyGroups.some((x) => x.branch === p[0] && x.group === g)) continue;
      capexPartyGroups.push({ branch: p[0], kind: 'supplier', group: g, ledgers: n });
    }
    capexPartyGroups.sort((a, b) => b.ledgers - a.ledgers);

    cashRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || (b.amount - a.amount));
    const cashRoll = (keyOf, labelOf) => {
      const m = new Map();
      for (const r of cashRows) {
        const k = keyOf(r);
        const e = m.get(k) || { key: k, label: labelOf(r), spend: 0, disposal: 0, count: 0 };
        e.spend = Math.round((e.spend + r.amount) * 100) / 100;
        e.count++;
        m.set(k, e);
      }
      return [...m.values()];
    };
    const cashByMonth = cashRoll((r) => r.date.slice(0, 6), (r) => LM.bucketLabel(r.date.slice(0, 6), 'month'))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const cashByKind = cashRoll((r) => r.kind, (r) => r.kind).sort((a, b) => b.spend - a.spend);

    res.json({ ok: true, branch, from, to, min,
      scaleNote: 'A purchase DEBITS the asset (Tally -ve) and is reported as `spend`; a credit to the same ledger is a disposal and is kept apart, never netted. Where one voucher debits one asset and credits another -- capitalising work in progress -- that much is a transfer and is neither.',
      rows, count: rows.length,
      additions, disposals, net: Math.round((additions - disposals) * 100) / 100,
      moved: movedTotal,
      cashOut, cashRows, cashByMonth, cashByKind, capexPartyGroups, advanceGroups,
      unmatchedSupplier,
      byGroup, byMonth, byAsset, byFunding, excludedGroups });
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
