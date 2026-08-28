// Real-browser test of the Suggested-merges panel end to end: the actual portal
// HTML, the actual /api/alias-suggestions endpoint, a stubbed Mongo holding a
// planted rename. Verifies the suggestion reaches the screen with its evidence,
// that Accept writes the alias, and that "Not same" is remembered server-side.
const path = require('path');
const fsx = require('fs');
const { chromium } = require('playwright-core');

// playwright-core does not ship a browser; use the one this image provides.
const CHROME = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find((p) => fsx.existsSync(p));

// ---- Mongo stub (same shape as the other fake tests) -----------------------
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) { Object.assign(f, set); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async bulkWrite(ops) { for (const o of ops) await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert }); return { upsertedCount: ops.length, modifiedCount: 0, matchedCount: 0 }; }
  async deleteMany() { return { deletedCount: 0 }; }
  async deleteOne() { return { deletedCount: 0 }; }
  find(filter = {}) { const arr = this.docs.filter((d) => matches(d, filter)); return { sort() { return this; }, limit() { return this; }, project() { return this; }, async toArray() { return arr; } }; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}) { return this.docs.find((x) => matches(x, filter)) || null; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.PORT = '0';
const app = require('./server');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

const GST = '19AABCG1234M1Z5';
const V = (date, party, amt, gstin) => ({
  _id: 'kol:' + date + party, branch: 'kol', guid: date + party, date, type: 'Sales',
  ledgers: { Sales: amt }, party_ledgers: { [party]: -amt },
  details: gstin ? { partyGstin: gstin } : {}, bills: [],
});

(async () => {
  // Planted: one party, renamed between FY22 and FY24, same GSTIN, no overlap.
  fakeDb.collection('vouchers').docs.push(
    V('20210510', 'M/S Gleebuds', 100000, GST), V('20211220', 'M/S Gleebuds', 120000, GST),
    V('20230715', 'Gleebuds Paper Pvt Ltd', 150000, GST), V('20240220', 'Gleebuds Paper Pvt Ltd', 160000, GST),
    // A pair that must stay a question: alike, but trading side by side.
    V('20250601', 'Sunrise Papers', 90000, null), V('20250605', 'Sunrise Paper Mills', 95000, null),
    V('20260101', 'Sunrise Papers', 80000, null), V('20260105', 'Sunrise Paper Mills', 85000, null),
  );
  fakeDb.collection('masters').docs.push({ branch: 'kol', ledgers: {
    'M/S Gleebuds': 'Sundry Debtors', 'Gleebuds Paper Pvt Ltd': 'Sundry Debtors',
    'Sunrise Papers': 'Sundry Debtors', 'Sunrise Paper Mills': 'Sundry Debtors',
  }, groups: { 'Sundry Debtors': 'Current Assets', 'Current Assets': null }, contacts: {} });

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const api = await (await fetch(`${base}/api/alias-suggestions?branch=all`)).json();
  console.log('endpoint:', JSON.stringify(api.suggestions.map((s) => `${s.tier} ${s.variant} -> ${s.canonical}`)));
  assert(api.suggestions.length >= 1, 'endpoint returns the planted rename');
  assert(api.suggestions[0].canonical === 'Gleebuds Paper Pvt Ltd', 'endpoint picks the current name as canonical');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // Loaded from file://, so the portal's own startup fetch of /api/files resolves
  // to file:///api/files and fails at the network layer. It is caught in the page
  // and says nothing about this feature; real JS errors still fail the test.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|file:\/\/\/api\//.test(m.text())) errors.push(m.text()); });
  // The CDN is unreachable here; serve React from node_modules instead.
  const reactJs = fsx.readFileSync(path.join(__dirname, 'node_modules/react/umd/react.production.min.js'), 'utf8');
  const reactDom = fsx.readFileSync(path.join(__dirname, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('react-dom')) return route.fulfill({ contentType: 'application/javascript', body: reactDom });
    if (u.includes('libs/react/')) return route.fulfill({ contentType: 'application/javascript', body: reactJs });
    if (u.includes('xlsx')) return route.fulfill({ contentType: 'application/javascript', body: 'window.XLSX={utils:{}};' });
    if (u.includes('fonts.g')) return route.fulfill({ contentType: 'text/css', body: '' });
    return route.continue();
  });
  await page.goto('file://' + path.join(__dirname, '..', 'portal', 'index.html'));
  await page.waitForSelector('button');

  // Mount the dialog directly: reaching it through the upload flow needs a full
  // dataset, and what is under test is the panel, not the portal's front door.
  await page.evaluate((apiBase) => {
    window.__cdcFromApi = true; window.__cdcApiBase = apiBase;
    const host = document.createElement('div');
    document.body.appendChild(host);
    window.__saved = null;
    if (typeof window.AliasModal !== 'function') throw new Error('AliasModal is not a global — the portal shell got wrapped?');
    ReactDOM.render(React.createElement(window.AliasModal, {
      aliases: {}, names: ['M/S Gleebuds', 'Gleebuds Paper Pvt Ltd'], outstanding: {},
      onSave: (m) => { window.__saved = m; }, onClose: () => {},
    }), host);
  }, base);

  await page.click('text=Find merges automatically');
  await page.waitForSelector('text=SUGGESTED MERGES');
  await page.waitForFunction(() => !document.body.innerText.includes('Scanning every voucher'), null, { timeout: 10000 });
  const shown = await page.evaluate(() => document.body.innerText);
  assert(/CERTAIN/.test(shown), 'the rename is shown, tagged CERTAIN');
  assert(/same GSTIN 19AABCG1234M1Z5/.test(shown), 'the evidence names the shared GSTIN');
  assert(/activity does not overlap/.test(shown), 'the evidence states the activity windows do not overlap');
  assert(!/Sunrise/.test(shown), 'the side-by-side lookalikes are not offered at all');
  await page.screenshot({ path: path.join(require('os').tmpdir(), 'alias_suggestions.png') });

  await page.click('text=Not same');
  await page.waitForFunction(() => !document.body.innerText.includes('CERTAIN'), null, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 400)); // let the POST land
  const stored = await (await fetch(`${base}/api/aliases`)).json();
  assert((stored.dismissed || []).length === 1, '"Not same" is stored server-side, not just hidden locally');
  const again = await (await fetch(`${base}/api/alias-suggestions?branch=all`)).json();
  assert(again.suggestions.length === 0, 'a dismissed pair is not offered again');

  assert(errors.length === 0, 'no console/page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== alias suggestion UI passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
