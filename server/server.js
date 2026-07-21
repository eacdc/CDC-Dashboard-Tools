// CDC Dashboard API — ingest Tally JSON into MongoDB and serve it back to the
// dashboards by date range. Also serves the static dashboards so the whole thing
// can run as a single Render web service.
require('./loadEnv');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getDb, close } = require('./db');
const { ingest, getSyncState, syncIncremental } = require('./ingest');

const PORT = process.env.PORT || 3000;
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const REPO_ROOT = path.join(__dirname, '..');

const app = express();
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
      const master = await db.collection('masters').findOne({ branch }, { projection: { _id: 0, updatedAt: 0 } });
      const vouchers = await db.collection('vouchers')
        .find({ branch, date: { $gte: from, $lte: to } },
              { projection: { _id: 0, branch: 0, guid: 0, updatedAt: 0 } })
        .sort({ date: 1 })
        .toArray();
      out.branches[branch] = {
        hierarchy: master ? { ledgers: master.ledgers, groups: master.groups } : null,
        vouchers,
      };
    }
    res.json(out);
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

// ---- static dashboards ------------------------------------------------------
// Served from the repo root so /consolidated, /projected, /dashboard work.
app.use('/consolidated', express.static(path.join(REPO_ROOT, 'consolidated')));
app.use('/projected', express.static(path.join(REPO_ROOT, 'projected')));
app.use('/dashboard', express.static(path.join(REPO_ROOT, 'dashboard')));
app.use('/portal', express.static(path.join(REPO_ROOT, 'portal')));
app.get('/', (_req, res) => {
  res.type('html').send(
    '<h2>CDC Dashboard API</h2><ul>' +
    '<li><a href="/portal/">/portal/</a> (unified: P&amp;L / Cashflow / Projection)</li>' +
    '<li><a href="/consolidated/">/consolidated/</a></li>' +
    '<li><a href="/projected/">/projected/</a></li>' +
    '<li><a href="/dashboard/">/dashboard/</a></li>' +
    '<li><a href="/api/meta">/api/meta</a> &middot; <a href="/health">/health</a></li></ul>'
  );
});

const server = app.listen(PORT, () => console.log(`CDC API listening on :${PORT}`));
process.on('SIGTERM', async () => { await close(); server.close(); });
process.on('SIGINT', async () => { await close(); server.close(); process.exit(0); });

module.exports = app;
