// Checks the year-on-year fold against the dashboard itself.
//
// The whole feature rests on one claim: the figures the server computes for a
// financial year are the figures the P&L / Cashflow tabs show for that same year. So
// this runs the SAME vouchers through the browser's processData in Chromium and
// through server/yoySummary.js, and compares every monthly number.
//
// If that ever fails, the year-on-year table is lying about the business, which is
// worse than not having it -- hence a real browser rather than a re-implementation
// of the comparison.
const path = require('path');
const fsx = require('fs');
const { chromium } = require('playwright-core');
const { summarise, fyOf, fyLabel, monthOf } = require('./yoySummary');

const CHROME = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find((p) => fsx.existsSync(p));

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

// A hierarchy touching every P&L bucket, both cash sides, and an inter-branch ledger.
const xd = {
  ledgers: {
    'Sales - Job Work': 'Sales Accounts', 'Export Sales': 'Sales Accounts',
    'Paper Purchase': 'Purchase Accounts', 'Freight Inward': 'Direct Expenses',
    'Salary': 'Indirect Expenses', 'Bank Charges': 'Indirect Expenses',
    'Modern Herbo': 'Sundry Debtors', 'Gleebuds': 'Sundry Debtors',
    'Paper Supplier': 'Sundry Creditors',
    'HDFC Current': 'Bank Accounts', 'Petty Cash': 'Cash-in-Hand',
    'CDC Ahmedabad': 'Branch / Divisions',
  },
  groups: {
    'Sales Accounts': 'Revenue Account', 'Purchase Accounts': 'Revenue Account',
    'Direct Expenses': 'Revenue Account', 'Indirect Expenses': 'Revenue Account',
    'Sundry Debtors': 'Current Assets', 'Sundry Creditors': 'Current Liabilities',
    'Bank Accounts': 'Current Assets', 'Cash-in-Hand': 'Current Assets',
    'Branch / Divisions': 'Capital Account',
    'Current Assets': 'Capital Account', 'Current Liabilities': 'Capital Account',
    'Revenue Account': null, 'Capital Account': null,
  },
};

// Tally signs: Cr positive, Dr negative. Sales credit the income account and debit
// the debtor; purchases and expenses are the other way round.
let n = 0;
const mk = (branch, date, type, ledgers, party_ledgers) =>
  ({ branch, _branch: branch, date, type, no: 'V' + (++n), ledgers, party_ledgers });

const vouchers = [
  // --- FY 2024-25 -----------------------------------------------------------
  mk('kol', '20240415', 'Sales', { 'Sales - Job Work': 100000 }, { 'Modern Herbo': -100000 }),
  mk('kol', '20240520', 'Sales', { 'Export Sales': 250000 }, { 'Gleebuds': -250000 }),
  mk('kol', '20240610', 'Purchase', { 'Paper Purchase': -60000, 'Freight Inward': -4000 }, { 'Paper Supplier': 64000 }),
  mk('kol', '20241105', 'Journal', { 'Salary': -30000 }, {}),
  mk('kol', '20250310', 'Journal', { 'Bank Charges': -1200 }, {}),
  mk('kol', '20240720', 'Bank Receipt', { 'HDFC Current': -90000 }, { 'Modern Herbo': 90000 }),
  mk('kol', '20240820', 'Bank Payments', { 'HDFC Current': 50000 }, { 'Paper Supplier': -50000 }),
  mk('kol', '20241010', 'Contra', { 'HDFC Current': 20000, 'Petty Cash': -20000 }, {}),
  // An inter-branch settlement: kept in the KOL view, dropped from consolidated.
  mk('kol', '20241120', 'Bank Receipt', { 'HDFC Current': -15000 }, { 'CDC Ahmedabad': 15000 }),
  mk('ahm', '20240925', 'Sales', { 'Sales - Job Work': 70000 }, { 'Gleebuds': -70000 }),
  mk('ahm', '20241220', 'Bank Payments', { 'HDFC Current': 12000 }, { 'Paper Supplier': -12000 }),
  // --- FY 2025-26, so year-on-year has a second column ----------------------
  mk('kol', '20250510', 'Sales', { 'Sales - Job Work': 180000 }, { 'Modern Herbo': -180000 }),
  mk('kol', '20250612', 'Purchase', { 'Paper Purchase': -75000 }, { 'Paper Supplier': 75000 }),
  mk('kol', '20251115', 'Journal', { 'Salary': -33000 }, {}),
  mk('kol', '20250815', 'Bank Receipt', { 'HDFC Current': -120000 }, { 'Modern Herbo': 120000 }),
  mk('ahm', '20250910', 'Sales', { 'Export Sales': 90000 }, { 'Gleebuds': -90000 }),
];

const server = summarise(vouchers, xd);

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
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
  // processData and friends live inside the Consolidated namespace IIFE, which only
  // exposes {Dash, build} -- neither of which lets a test ask for one branch and one
  // financial year. So re-run that namespace's body as a plain script: identical
  // code, its declarations now reachable as globals.
  const html = fsx.readFileSync(path.join(__dirname, '..', 'portal', 'index.html'), 'utf8');
  const start = html.indexOf('(function(){\nvar e=React.createElement');
  const end = html.indexOf('\n})();', start);
  if (start < 0 || end < 0) throw new Error('could not locate the Consolidated namespace in portal/index.html');
  await page.addScriptTag({ content: html.slice(start + '(function(){'.length, end) });
  const ok = await page.evaluate(() => typeof window.processData === 'function' && typeof window.findIBLedgers === 'function');
  assert(ok, "the dashboard's own processData is available to compare against");

  // Ask the portal's own engine for each (branch, FY) the server claims to know.
  async function browserFY(branch, fyStart) {
    return page.evaluate(({ vouchers, xd, branch, fyStart }) => {
      // processData derives the FY window from the LATEST voucher date, so feed it
      // only what belongs at or before the year being asked about; fyOffset then
      // walks back to that year exactly as the dashboard's Prior-FY toggle does.
      const upto = vouchers.filter((v) => v.date < String(fyStart + 1) + '0401');
      const last = upto.map((v) => v.date).sort().pop();
      const lastFY = (+last.slice(4, 6) >= 4) ? +last.slice(0, 4) : +last.slice(0, 4) - 1;
      const ib = window.findIBLedgers(xd);
      const d = window.processData(upto, xd, null, ib, 12, fyStart - lastFY, branch);
      return { rev: d.pl.revM, pur: d.pl.purchM, de: d.pl.dirExpM, ie: d.pl.indExpM,
               gp: d.pl.gpM, np: d.pl.npM, cin: d.cf.inM, cout: d.cf.outM, cnet: d.cf.netM };
    }, { vouchers, xd, branch, fyStart });
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.005);
  for (const branch of ['all', 'kol', 'ahm']) {
    for (const fy of server.fys) {
      const row = server.branches[branch] && server.branches[branch][fy];
      if (!row) continue;
      const bro = await browserFY(branch, parseInt(fy.slice(0, 4), 10));
      const pairs = [['revenue', 'rev'], ['purchase', 'pur'], ['directExp', 'de'], ['indirectExp', 'ie'],
                     ['gp', 'gp'], ['np', 'np'], ['cashIn', 'cin'], ['cashOut', 'cout'], ['cashNet', 'cnet']];
      for (const [srvKey, broKey] of pairs) {
        if (!same(row[srvKey], bro[broKey])) {
          console.error(`   ${branch}/${fy} ${srvKey}\n     server : ${JSON.stringify(row[srvKey])}\n     browser: ${JSON.stringify(bro[broKey])}`);
        }
        assert(same(row[srvKey], bro[broKey]), `${branch} ${fy} ${srvKey} matches the dashboard month for month`);
      }
    }
  }

  // Sanity on the fold itself, independent of the browser.
  assert(server.fys.join(',') === '2024-25,2025-26', 'both financial years appear, April-March');
  assert(server.branches.all['2024-25'].revenue[0] === 100000, 'April 2024 revenue lands in month 0');
  assert(server.branches.all['2024-25'].revenue[11] === 0, 'March 2025 is month 11 and empty here');
  assert(server.branches.kol['2024-25'].totals.cashIn > server.branches.all['2024-25'].totals.cashIn,
    'the inter-branch receipt counts for KOL but is eliminated from consolidated');
  assert(server.branches.ahm['2024-25'].totals.revenue === 70000, 'the Ahmedabad branch keeps its own total');

  await browser.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== year-on-year fold matches the dashboard ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
