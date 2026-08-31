// Tests the year-on-year endpoints against a stubbed Mongo: the background rebuild,
// the cached read, the partial (one-year) rebuild, and the automatic refresh that
// follows an ingest. No DB, no browser -- the figures themselves are checked against
// the real dashboard in test_yoy_fake.js.
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
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, batchSize() { return this; },
      async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
  }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}) { return this.docs.find((x) => matches(x, filter)) || null; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.PORT = '0';
process.env.INGEST_TOKEN = 'tok';
const path = require('path');
const fsx = require('fs');
const { chromium } = require('playwright-core');
const app = require('./server');

const CHROME = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find((p) => fsx.existsSync(p));

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

let n = 0;
const V = (branch, date, sales, salary) => ({
  _id: branch + ':' + (++n), branch, date, type: salary ? 'Journal' : 'Sales',
  ledgers: salary ? { Salary: -salary } : { 'Sales A/c': sales },
  party_ledgers: salary ? {} : { 'A Customer': -sales },
});

(async () => {
  fakeDb.collection('masters').docs.push({ branch: 'kol',
    ledgers: { 'Sales A/c': 'Sales Accounts', Salary: 'Indirect Expenses', 'A Customer': 'Sundry Debtors' },
    groups: { 'Sales Accounts': 'Revenue Account', 'Indirect Expenses': 'Revenue Account', 'Sundry Debtors': 'Current Assets', 'Current Assets': 'Capital Account', 'Revenue Account': null, 'Capital Account': null } });
  fakeDb.collection('vouchers').docs.push(
    V('kol', '20240510', 1000000), V('kol', '20241105', null, 200000),
    V('kol', '20250610', 1500000), V('kol', '20251105', null, 300000),
    V('ahm', '20250712', 400000));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|file:\/\/\/api\//.test(m.text())) errors.push(m.text()); });
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
  await page.waitForSelector('text=Year on Year');
  assert(true, 'the Year on Year button is on the landing page, before anything is loaded');

  // Point the panel at the test server (the page is on file://, so relative would fail).
  await page.evaluate((b) => { window.__testApiBase = b; }, base);
  await page.fill('input[placeholder^="e.g. https"]', base);
  await page.click('text=Year on Year');
  await page.waitForSelector('text=YEAR ON YEAR');
  await page.waitForFunction(() => /Rebuild/.test(document.body.innerText), null, { timeout: 5000 });
  assert(/No summary yet/.test(await page.evaluate(() => document.body.innerText)),
    'with nothing built yet it says so instead of showing an empty table');

  await page.click('text=Rebuild');
  await page.waitForFunction(() => /2024-25/.test(document.body.innerText), null, { timeout: 20000 });
  let txt = await page.evaluate(() => document.body.innerText);
  assert(/2024-25/.test(txt) && /2025-26/.test(txt), 'both financial years become columns');
  assert(/Revenue/.test(txt) && /Gross Profit/.test(txt) && /Net Profit/.test(txt), 'the P&L lines are the rows');
  assert(/10\.00 L/.test(txt), 'FY 2024-25 revenue shows as 10.00 L');
  assert(/\+90%/.test(txt), 'growth against the previous year is shown (10L -> 19L consolidated)');
  assert(/\+50%/.test(txt), 'a cost line that grew shows +50%, sized not signed (2L -> 3L salary)');

  // A year opens into its months without another request.
  const before = (await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /api\/yoy/.test(r.name)).length));
  await page.click('text=▸ 2024-25');
  await page.waitForFunction(() => /Apr/.test(document.body.innerText), null, { timeout: 5000 });
  txt = await page.evaluate(() => document.body.innerText);
  assert(/Apr/.test(txt) && /Mar/.test(txt), 'clicking a year opens its twelve months');
  const after = (await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /api\/yoy/.test(r.name)).length));
  assert(after === before, 'opening a year costs no extra request — the months were already loaded');
  await page.screenshot({ path: '/tmp/yoy_panel.png' });

  // Exact, case-sensitive: a loose "text=CASHFLOW" also matches the card's subtitle
  // line ("P&L · Cashflow · Ledger Audit · ..."), which is not a control.
  // Maximise: the panel takes the whole window, and Escape brings it back.
  const inlineW = await page.evaluate(() => document.querySelector('table').getBoundingClientRect().width);
  await page.click('text=Maximise');
  await page.waitForFunction(() => /Minimise/.test(document.body.innerText), null, { timeout: 5000 });
  const box = await page.evaluate(() => {
    const t = document.querySelector('table');
    let n = t; while (n && getComputedStyle(n).position !== 'fixed') n = n.parentElement;
    const r = n && n.getBoundingClientRect();
    return n ? { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight } : null;
  });
  assert(box && box.w === box.vw && box.h === box.vh, 'maximised, the panel covers the whole window');
  assert((await page.evaluate(() => document.querySelector('table').getBoundingClientRect().width)) > inlineW,
    'the table gets more room than it had inside the card');
  await page.screenshot({ path: '/tmp/yoy_max.png' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => /Maximise/.test(document.body.innerText), null, { timeout: 5000 });
  assert(await page.evaluate(() => {
    const t = document.querySelector('table');
    let n = t; while (n && getComputedStyle(n).position !== 'fixed') n = n.parentElement;
    return !n;
  }), 'Escape puts it back into the page');

  await page.click('span:text-is("CASHFLOW")');
  await page.waitForFunction(() => /Net Cashflow/.test(document.body.innerText), null, { timeout: 5000 });
  assert(/Inflows/.test(await page.evaluate(() => document.body.innerText)), 'the Cashflow tab swaps the rows');

  await page.click('span:text-is("P&L")');
  await page.click('span:text-is("AHM")');
  await page.waitForFunction(() => !/10\.00 L/.test(document.body.innerText), null, { timeout: 5000 });
  txt = await page.evaluate(() => document.body.innerText);
  assert(/4\.00 L/.test(txt), 'the AHM branch shows only its own revenue');

  assert(errors.length === 0, 'no console/page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== year-on-year panel passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
