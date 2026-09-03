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
      // Mongo matches $in against an ARRAY field element-wise: the doc matches if any
      // element is in the list. The voucher drill-down relies on that to find a party
      // under every name it has been merged from.
      if ('$in' in cond) {
        const hit = Array.isArray(val) ? val.some((x) => cond.$in.includes(x)) : cond.$in.includes(val);
        if (!hit) return false;
      }
    } else if (Array.isArray(val)) { if (!val.includes(cond)) return false; }
    else if (val !== cond) return false;
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
  // The voucher drill-down matches a ledger by KEY LIST rather than a dotted path
  // (Tally names contain dots); enough of that pipeline to answer it here.
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$match) rows = rows.filter((d) => matches(d, st.$match));
      else if (st.$addFields) rows = rows.map((d) => ({ ...d, _k: Object.keys(d.ledgers || {}).concat(Object.keys(d.party_ledgers || {})) }));
      else if (st.$sort) { const k = Object.keys(st.$sort)[0]; rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * st.$sort[k]); }
      else if (st.$limit) rows = rows.slice(0, st.$limit);
      else if (st.$project) rows = rows.map((d) => { const o = {}; for (const k of Object.keys(st.$project)) if (st.$project[k] === 1) o[k] = d[k]; return o; });
    }
    return { async toArray() { return rows; } };
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
    // FY 2024-25: profit of 8 L.
    V('kol', '20240510', 1000000), V('kol', '20241105', null, 200000),
    // FY 2025-26: expenses exceed revenue -> a LOSS. The old magnitude formula called
    // this growth, in green; it must now read as the fall it is.
    // April here gives the part year below something to be compared against.
    V('kol', '20250415', 100000), V('kol', '20250610', 1400000), V('kol', '20251105', null, 2500000),
    V('ahm', '20250712', 400000),
    // FY 2026-27: only April and May booked -- a part year.
    V('kol', '20260410', 300000), V('kol', '20260512', 200000));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  // Rows are opened by clicking their name, one level at a time, exactly as the P&L
  // tab's tree behaves -- a line first, then the group inside it.
  const openRow = async (re) => page.evaluate((src) => {
    const rx = new RegExp(src);
    const r = [...document.querySelectorAll('tr')].find((x) => x.cells[0] && rx.test(x.cells[0].innerText.trim()));
    if (!r) throw new Error('no row matching ' + src);
    r.cells[0].click();
  }, re);
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

  // ---- the Sales Analysis tab, which is where the panel opens ----------------
  // The office reads the year by customer before it reads it by income account, so
  // this is the default view, and its sections are party-anchored: the sale is
  // attributed to the debtor it was invoiced to, not to the ledger it was posted to.
  let txt = await page.evaluate(() => document.body.innerText);
  assert(/SALES . SUNDRY DEBTORS/.test(txt), 'the panel opens on the Sales Analysis tab');
  assert(/PURCHASES . SUNDRY CREDITORS/.test(txt), 'with the purchase section under it');
  const plRows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')]
    .some((r) => r.cells[0] && /^.?\s*(Gross Profit|Net Profit)$/.test(r.cells[0].innerText.trim())));
  assert(!plRows, 'and the P&L lines are not mixed into it');
  await page.waitForFunction(() => /10\.00 L/.test(document.body.innerText), null, { timeout: 8000 });
  assert(true, 'the sales section carries its own total without being expanded');

  // The sales section starts open -- the customers are the point of the tab, not
  // something to go looking for -- and the parties hang off it by their Tally groups.
  await page.waitForFunction(() => /A Customer/.test(document.body.innerText), null, { timeout: 8000 });
  assert(true, 'the customers are listed without anything being clicked');
  await openRow('SALES . SUNDRY DEBTORS');
  await page.waitForFunction(() => !/A Customer/.test(document.body.innerText), null, { timeout: 8000 });
  assert(true, 'and the section closes again on its own click');
  await openRow('SALES . SUNDRY DEBTORS');
  await page.waitForFunction(() => /A Customer/.test(document.body.innerText), null, { timeout: 8000 });
  const saCmp = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')];
    const pick = (re) => rows.find((r) => r.cells[0] && re.test(r.cells[0].innerText.trim()));
    const num = (r) => r.cells[1].innerText.split('\n')[0];
    return { section: num(pick(/SALES . SUNDRY DEBTORS/)), party: num(pick(/A Customer/)) };
  });
  assert(saCmp.section === saCmp.party,
    'the only customer carries the whole section: ' + saCmp.section + ' vs ' + saCmp.party);

  // A party is a leaf, so its figures open the vouchers behind them.
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('tr')].find((x) => x.cells[0] && /A Customer/.test(x.cells[0].innerText));
    r.cells[1].click();
  });
  await page.waitForFunction(() => /\d{2}-\w{3}-\d{4}/.test(document.body.innerText), null, { timeout: 8000 });
  assert(/A Customer/.test(await page.evaluate(() => document.body.innerText)),
    'clicking a customer figure lists that customer vouchers for the year');
  await page.click('text=Close');

  // The three measures are three different folds, so switching must re-ask.
  const beforeMeas = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /yoy\/party/.test(r.name)).length);
  await page.click('span:text-is("Gross")');
  await page.waitForFunction((n) => performance.getEntriesByType('resource').filter((r) => /yoy\/party/.test(r.name)).length > n, beforeMeas, { timeout: 8000 });
  assert(true, 'switching to Gross asks the server for that measure rather than reusing Net');

  await page.click('span:text-is("P&L")');
  await page.waitForFunction(() => /Gross Profit/.test(document.body.innerText), null, { timeout: 8000 });
  txt = await page.evaluate(() => document.body.innerText);
  assert(/2024-25/.test(txt) && /2025-26/.test(txt), 'both financial years become columns');
  assert(/Revenue/.test(txt) && /Gross Profit/.test(txt) && /Net Profit/.test(txt), 'the P&L lines are the rows');
  assert(/10\.00 L/.test(txt), 'FY 2024-25 revenue shows as 10.00 L');
  assert(/\+90%/.test(txt), 'growth against the previous year is shown (10L -> 19L consolidated)');
  assert(/\+1150%/.test(txt), 'a cost line that grew is compared by size (2L -> 25L salary)');

  // The bug this fixture exists for: profit -> loss must not read as growth.
  const npPct = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => /Net Profit/.test(r.cells[0].innerText));
    const c = row.cells[2];                       // FY 2025-26, the loss year
    return { text: c.innerText, bg: getComputedStyle(c).backgroundColor };
  });
  assert(/-\d+%/.test(npPct.text), 'a profit turning into a loss shows a FALL, not growth: ' + npPct.text.replace(/\n/g, ' '));
  assert(/rgba?\(2[0-9]{2},\s*3[0-9],\s*3[0-9]/.test(npPct.bg), 'and that cell is tinted red, not green: ' + npPct.bg);

  // Colour depth follows the size of the move, and a helpful move is green.
  const revBg = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => /Revenue/.test(r.cells[0].innerText));
    return getComputedStyle(row.cells[2]).backgroundColor;
  });
  assert(/rgba?\(22,\s*163,\s*74/.test(revBg), 'revenue growth is tinted green: ' + revBg);

  // The year in progress is flagged and compared like for like.
  assert(/part year/.test(txt), 'the unfinished financial year is labelled as one');
  assert((txt.match(/part year/g) || []).length === 1,
    'and ONLY that one: an older year with an empty February is finished, not partial');
  const partPct = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => /Revenue/.test(r.cells[0].innerText));
    const c = row.cells[row.cells.length - 1];
    return { text: c.innerText, title: c.querySelector('div[title]') ? c.querySelector('div[title]').title : '' };
  });
  assert(/vs same months/.test(partPct.title),
    'a part year is compared against the same months of the year before, not the full year: ' + partPct.title);
  assert(/\+400%/.test(partPct.text),
    'and the like-for-like figure is used (Apr+May 5L vs Apr+May 1L), not 5L against a full 19L: ' + partPct.text.replace(/\n/g, ' '));

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

  // ---- opening a line down to its accounts, and then to the vouchers ----------
  await page.click('span:text-is("KOL")');
  await page.waitForFunction(() => /10\.00 L/.test(document.body.innerText), null, { timeout: 5000 });
  // Rows are opened by clicking their name, one level at a time, exactly as the P&L
  // tab's tree behaves -- a line first, then the group inside it.
  await openRow('^.?\\s*Revenue$');
  await page.waitForFunction(() => /Sales Accounts/.test(document.body.innerText), null, { timeout: 8000 });
  assert(true, 'opening Revenue shows the Tally group under it');
  assert(!/Sales A\/c/.test(await page.evaluate(() => document.body.innerText)),
    'and stops there -- a group opens on its own click, as in the P&L tab');

  await openRow('Sales Accounts');
  await page.waitForFunction(() => /Sales A\/c/.test(document.body.innerText), null, { timeout: 8000 });
  assert(true, 'opening the group shows the ledger itself');

  // The account's figures must BE the line's figures, not a second calculation.
  const cmp = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')];
    const pick = (re) => rows.find((r) => r.cells[0] && re.test(r.cells[0].innerText.trim()));
    const num = (r) => r.cells[1].innerText.split('\n')[0];
    return { line: num(pick(/^.?\s*Revenue$/)), group: num(pick(/Sales Accounts/)), ledger: num(pick(/Sales A\/c/)) };
  });
  assert(cmp.line === cmp.ledger && cmp.group === cmp.ledger,
    'the only revenue ledger carries the whole line, through its group: '
    + [cmp.line, cmp.group, cmp.ledger].join(' / '));

  // The part-year rule belongs to the YEAR, so it has to reach the accounts too.
  // Without it the newest column compared this ledger's two booked months against a
  // full twelve and painted a growing account red.
  const partRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr')];
    const pick = (re) => rows.find((r) => r.cells[0] && re.test(r.cells[0].innerText.trim()));
    const last = (r) => { const c = r.cells[r.cells.length - 1];
      return { text: c.innerText.replace(/\n/g, ' '), bg: getComputedStyle(c).backgroundColor,
        title: c.querySelector('div[title]') ? c.querySelector('div[title]').title : '' }; };
    return { line: last(pick(/^.?\s*Revenue$/)), ledger: last(pick(/Sales A\/c/)) };
  });
  assert(/vs same months/.test(partRow.ledger.title),
    'a ledger in the part year is compared like for like, as its line is: ' + partRow.ledger.title);
  assert(partRow.ledger.text === partRow.line.text,
    'so it reads the same as the line above it: ' + partRow.ledger.text + ' vs ' + partRow.line.text);
  assert(/rgba?\(22,\s*163,\s*74/.test(partRow.ledger.bg),
    'and is green like the line, not red from a five-months-against-twelve comparison: ' + partRow.ledger.bg);

  // Clicking a figure on the ledger opens the vouchers behind it.
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('tr')].find((x) => x.cells[0] && /Sales A\/c/.test(x.cells[0].innerText));
    r.cells[1].click();
  });
  await page.waitForFunction(() => /\d{2}-\w{3}-\d{4}/.test(document.body.innerText), null, { timeout: 8000 });
  txt = await page.evaluate(() => document.body.innerText);
  assert(/Sales A\/c/.test(txt) && /2024-25/.test(txt), 'the voucher list names the account and the year');
  assert(/10\.00 L/.test(txt), 'and its total is the figure that was clicked');
  // The voucher list is the table with a Date column, not simply the last one in the
  // document -- picking by position raced the modal's own render.
  const vrows = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')]
      .find((x) => x.tHead && /date/i.test(x.tHead.innerText) && /party/i.test(x.tHead.innerText));
    if (!t) return ['NO VOUCHER TABLE'];
    return [...t.querySelectorAll('tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim());
  });
  assert(vrows.length === 1 && /May-2024/.test(vrows[0]),
    'exactly the one voucher of that year is listed, with its date: ' + JSON.stringify(vrows));
  await page.screenshot({ path: '/tmp/yoy_drill.png' });
  await page.click('text=Close');
  await page.waitForFunction(() => !/Looking these up/.test(document.body.innerText), null, { timeout: 5000 });

  // A group is not clickable through to vouchers -- it is many accounts, not one.
  const groupClickable = await page.evaluate(() => {
    const r = [...document.querySelectorAll('tr')].find((x) => x.cells[0] && /Sales Accounts/.test(x.cells[0].innerText));
    return getComputedStyle(r.cells[1]).cursor;
  });
  assert(groupClickable === 'default', 'a group row offers no voucher list: ' + groupClickable);

  // Switching branch must not leave one branch's accounts under another's totals.
  await page.click('span:text-is("AHM")');
  await page.waitForFunction(() => !/Sales A\/c/.test(document.body.innerText), null, { timeout: 8000 });
  assert(true, 'changing branch re-asks for that branch’s accounts instead of reusing the last');

  assert(errors.length === 0, 'no console/page errors: ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== year-on-year panel passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
