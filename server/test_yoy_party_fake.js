// The year-on-year Sales Analysis: the same numbers the Sales Analysis tab shows.
//
// That tab attributes a whole invoice to its DOMINANT Sundry-Debtor party (or
// Sundry-Creditor, for purchases) and offers three measures of it. None of that is
// obvious enough to re-implement on trust, so the same vouchers go through the
// browser's processData in Chromium and through server/yoySummary.js, and every
// party's monthly figure is compared -- for all three measures, both sections, and
// each branch, including consolidated, where dropping the inter-branch ledgers can
// change WHICH party is dominant.
//
// The tree is then checked to open the way the screenshot does: salesperson group
// first, the company under it, the party's own ledger at the bottom.
const path = require('path');
const fsx = require('fs');
const { chromium } = require('playwright-core');
const yoy = require('./yoySummary');

const CHROME = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find((p) => fsx.existsSync(p));

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

// Debtors nested the way Tally holds them at CDC: a salesperson group, a company
// group under it, the party at the bottom. Creditors are flatter, as they are there.
const xd = {
  ledgers: {
    'Sales - Job Work': 'Sales Accounts', 'Export Sales': 'Sales Accounts',
    'Shipping Charges': 'Direct Incomes',          // revenue, but NOT a Sales Account
    'Output GST': 'Duties & Taxes',
    'Paper Purchase': 'Purchase Accounts', 'Freight Inward': 'Direct Expenses',
    'Salary': 'Indirect Expenses',
    'Modern Herbo': 'Ratna Sagar Group', 'Gleebuds': 'Ratna Sagar Group',
    'Hi Scan Pvt. Ltd. - Unit I': 'Export - S/Dr',
    'A.B. Traders': 'Pintu Ghosh',                 // a dotted name, as Tally has
    // The same customer, entered twice. Only the second name survives in the master;
    // the merge map bridges the first, which is how the office fixes this in the UI.
    'Carbonlite Print & Publishing (AHD)': 'Export - S/Dr',
    'Paper Supplier': 'Sundry Creditors', 'Ink Supplier': 'Sundry Creditors',
    'HDFC Current': 'Bank Accounts',
    'CDC Ahmedabad': 'Branch / Divisions',
  },
  groups: {
    'Sales Accounts': 'Revenue Account', 'Purchase Accounts': 'Revenue Account',
    'Direct Expenses': 'Revenue Account', 'Indirect Expenses': 'Revenue Account',
    'Direct Incomes': 'Revenue Account',
    'Duties & Taxes': 'Current Liabilities',
    // salesperson -> company -> party
    'Export - S/Dr': 'Sundry Debtors', 'Pintu Ghosh': 'Sundry Debtors',
    'Ratna Sagar Group': 'Export - S/Dr',
    'Sundry Debtors': 'Current Assets', 'Sundry Creditors': 'Current Liabilities',
    'Bank Accounts': 'Current Assets', 'Branch / Divisions': 'Capital Account',
    'Current Assets': 'Capital Account', 'Current Liabilities': 'Capital Account',
    'Revenue Account': null, 'Capital Account': null,
  },
  ids: { 'Carbonlite Print & Publishing (AHD)': 'guid-carbon' },
};
// variant -> current name, exactly the shape /api/aliases stores.
const aliases = { 'Carbonlite Print & Publishing': 'Carbonlite Print & Publishing (AHD)' };

let n = 0;
const mk = (branch, date, type, ledgers, party_ledgers) =>
  ({ branch, _branch: branch, date, type, no: 'V' + (++n), ledgers, party_ledgers });

const vouchers = [
  // --- FY 2024-25 -----------------------------------------------------------
  // Net (P&L) 100000, net incl charges 105000, gross 123900 -- three different answers.
  mk('kol', '20240415', 'Sales',
    { 'Sales - Job Work': 100000, 'Shipping Charges': 5000, 'Output GST': 18900 },
    { 'Modern Herbo': -123900 }),
  mk('kol', '20240520', 'Sales', { 'Export Sales': 250000 }, { 'Gleebuds': -250000 }),
  mk('kol', '20240610', 'Sales', { 'Sales - Job Work': 40000 }, { 'A.B. Traders': -40000 }),
  mk('kol', '20240712', 'Sales', { 'Export Sales': 60000 }, { 'Hi Scan Pvt. Ltd. - Unit I': -60000 }),
  // Two debtors on one invoice: the bigger one takes the whole sale.
  mk('kol', '20240815', 'Sales', { 'Sales - Job Work': 90000 },
    { 'Gleebuds': -70000, 'Modern Herbo': -20000 }),
  // A sale settled against the other branch. In the KOL view the branch account is
  // the dominant party but is not a debtor, so Modern Herbo takes it; consolidated
  // drops the branch leg entirely and must land on the same party.
  mk('kol', '20240910', 'Sales', { 'Sales - Job Work': 55000 },
    { 'CDC Ahmedabad': -50000, 'Modern Herbo': -5000 }),
  mk('kol', '20241105', 'Purchase', { 'Paper Purchase': -60000, 'Freight Inward': -4000 },
    { 'Paper Supplier': 64000 }),
  mk('kol', '20241210', 'Purchase', { 'Paper Purchase': -22000 }, { 'Ink Supplier': 22000 }),
  // No debtor at all -- a journal that must not reach either section.
  mk('kol', '20250310', 'Journal', { 'Salary': -30000 }, {}),
  mk('ahm', '20240925', 'Sales', { 'Sales - Job Work': 70000 }, { 'Gleebuds': -70000 }),
  mk('ahm', '20241220', 'Purchase', { 'Paper Purchase': -12000 }, { 'Paper Supplier': 12000 }),
  // --- FY 2025-26, so the years splice -------------------------------------
  mk('kol', '20250510', 'Sales', { 'Sales - Job Work': 180000 }, { 'Modern Herbo': -180000 }),
  mk('kol', '20250612', 'Sales', { 'Export Sales': 33000 }, { 'A.B. Traders': -33000 }),
  mk('kol', '20250815', 'Purchase', { 'Paper Purchase': -75000 }, { 'Paper Supplier': 75000 }),
  mk('ahm', '20250910', 'Sales', { 'Export Sales': 90000 }, { 'Hi Scan Pvt. Ltd. - Unit I': -90000 }),
  // The merged customer, invoiced under the OLD name in one year and the CURRENT
  // one in the next. Both have to land on one row, or the year-on-year growth for
  // this customer is nonsense.
  mk('kol', '20241118', 'Sales', { 'Export Sales': 51100 }, { 'Carbonlite Print & Publishing': -51100 }),
  mk('kol', '20250715', 'Sales', { 'Export Sales': 40010 }, { 'Carbonlite Print & Publishing (AHD)': -40010 }),
];

const S = yoy.newSummary(xd, aliases);
for (const v of vouchers) yoy.addVoucher(S, v);
const summary = yoy.finalize(S);
const party = yoy.partyDetailOf(S);
const fys = summary.fys;

function leaves(nodes, out) {
  out = out || [];
  for (const nd of nodes || []) {
    if (nd.t === 'l') out.push(nd.n);
    leaves(nd.c, out); leaves(nd.l, out);
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const reactJs = fsx.readFileSync(path.join(__dirname, 'node_modules/react/umd/react.production.min.js'), 'utf8');
  const reactDom = fsx.readFileSync(path.join(__dirname, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('react-dom')) return route.fulfill({ contentType: 'application/javascript', body: reactDom });
    if (u.includes('libs/react/') || u.endsWith('/react.production.min.js')) return route.fulfill({ contentType: 'application/javascript', body: reactJs });
    if (u.includes('xlsx')) return route.fulfill({ contentType: 'application/javascript', body: 'window.XLSX={utils:{}};' });
    if (u.includes('fonts.g')) return route.fulfill({ contentType: 'text/css', body: '' });
    return route.continue();
  });
  await page.goto('file://' + path.join(__dirname, '..', 'portal', 'index.html'));
  await page.waitForSelector('button');
  const html = fsx.readFileSync(path.join(__dirname, '..', 'portal', 'index.html'), 'utf8');
  const start = html.indexOf('(function(){\nvar e=React.createElement');
  const end = html.indexOf('\n})();', start);
  if (start < 0 || end < 0) throw new Error('could not locate the Consolidated namespace in portal/index.html');
  await page.addScriptTag({ content: html.slice(start + '(function(){'.length, end) });
  assert(await page.evaluate(() => typeof window.processData === 'function'),
    "the dashboard's own Sales Analysis is available to compare against");

  // The Sales Analysis nodes the tab itself would draw, for one branch and one year.
  async function browserFY(branch, fyStart) {
    return page.evaluate(({ vouchers, xd, branch, fyStart, aliases }) => {
      // The dashboards canonicalise every voucher before anything is added up. It
      // mutates in place, so each call gets its own copy.
      const upto = JSON.parse(JSON.stringify(vouchers.filter((v) => v.date < String(fyStart + 1) + '0401')));
      window.__cdcAliases = aliases;
      window.__cdcCanon(xd, upto, null);
      const last = upto.map((v) => v.date).sort().pop();
      const lastFY = (+last.slice(4, 6) >= 4) ? +last.slice(0, 4) : +last.slice(0, 4) - 1;
      const ib = window.findIBLedgers(xd);
      const d = window.processData(upto, xd, null, ib, 12, fyStart - lastFY, branch);
      const pick = (nd) => {
        const out = {};
        (function walk(ns) {
          for (const x of ns || []) {
            if (x.type === 'ledger') out[x.name] = x.monthly;
            walk(x.children); walk(x.ledgers);
          }
        })(nd ? [nd] : []);
        return out;
      };
      const sa = d.sa.month;
      return {
        'sales|netpl': pick(sa.salesNetPL), 'sales|net': pick(sa.salesNet), 'sales|gross': pick(sa.salesGross),
        'purchase|netpl': pick(sa.purchNetPL), 'purchase|net': pick(sa.purchNet), 'purchase|gross': pick(sa.purchGross),
        salesRoot: sa.salesNetPL ? sa.salesNetPL.monthly : null,
        topNames: (sa.salesNetPL ? (sa.salesNetPL.children || []).map((c) => c.name) : []),
      };
    }, { vouchers, xd, branch, fyStart, aliases });
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.005);
  const zero = (a) => a.every((x) => Math.abs(x) < 0.005);
  let checked = 0, worst = null;
  for (const branch of ['all', 'kol', 'ahm']) {
    for (const fy of fys) {
      const bro = await browserFY(branch, parseInt(fy.slice(0, 4), 10));
      for (const key of ['sales|netpl', 'sales|net', 'sales|gross', 'purchase|netpl', 'purchase|net', 'purchase|gross']) {
        const srv = party[branch + '|' + key] || {};
        const names = new Set(Object.keys(bro[key]).concat(Object.keys(srv)));
        for (const name of names) {
          const b = bro[key][name] || new Array(12).fill(0);
          const s = (srv[name] && srv[name][fy]) || new Array(12).fill(0);
          checked++;
          if (!same(s, b) && !worst) {
            worst = `${branch}/${fy} ${key} ${name}\n     server : ${JSON.stringify(s)}\n     browser: ${JSON.stringify(b)}`;
          }
        }
      }
    }
  }
  assert(!worst, `every party, measure, branch and year matches the Sales Analysis tab (${checked} comparisons)` + (worst ? '\n   ' + worst : ''));
  assert(checked >= 60, `the fixture actually exercised the comparison (${checked} party-years)`);

  // ---- the three measures really are three different numbers ----------------
  const mh = (k) => (party['kol|' + k]['Modern Herbo'] || {})['2024-25'] || [];
  assert(mh('sales|netpl')[0] === 100000, 'Net (P&L) counts only the Sales Accounts leg');
  assert(mh('sales|net')[0] === 105000, 'Net + charges adds the shipping income');
  assert(mh('sales|gross')[0] === 123900, 'Gross is the full invoice the customer owes, GST included');

  // ---- the tree opens the way the Sales Analysis page does ------------------
  const built = yoy.partyTreeFrom(party['all|sales|netpl'], xd, fys, 'sales');
  const top = built.tree.map((x) => x.n);
  assert(top.indexOf('Export - S/Dr') >= 0 && top.indexOf('Pintu Ghosh') >= 0,
    'the first level under the section is the salesperson, not the income account');
  const exp = built.tree.find((x) => x.n === 'Export - S/Dr');
  assert(exp && (exp.c || []).some((c) => c.n === 'Ratna Sagar Group'),
    'the company group sits under its salesperson');
  const grp = exp.c.find((c) => c.n === 'Ratna Sagar Group');
  assert((grp.l || []).some((l) => l.n === 'Modern Herbo' && l.t === 'l'),
    'and the party ledgers are the leaves under the company');
  assert(built.tree.every((x) => x.n !== 'Sales Accounts' && x.n !== 'Sundry Debtors'),
    'nothing above the section leaks in -- the root itself is the header, not a row');

  // Every year's slots of the tree add back to the section root, so the header and
  // the rows can never disagree.
  let treeWorst = null;
  fys.forEach((fy, fi) => {
    // Only the top level: a group's months already include everything under it.
    let topOnly = 0;
    for (const x of built.tree) for (let i = fi * 12; i < fi * 12 + 12; i++) if (x.m[i]) topOnly += x.m[i];
    let root = 0;
    for (let i = fi * 12; i < fi * 12 + 12; i++) if (built.root[i]) root += built.root[i];
    if (Math.abs(topOnly - root) > 0.02 && !treeWorst) treeWorst = `${fy}: rows ${topOnly} vs section ${root}`;
  });
  assert(!treeWorst, 'each year of the tree adds up to the section header' + (treeWorst ? ' -- ' + treeWorst : ''));

  // ---- a party merged under two names is ONE row ----------------------------
  // The bug this guards: the dashboards merged the two spellings and the fold did
  // not, so the customer was whole on the Sales Analysis page and split in two here
  // -- and searching the name that lost found nothing on one page while the other
  // still listed it.
  const carbon = 'Carbonlite Print & Publishing (AHD)';
  const merged = party['kol|sales|netpl'][carbon] || {};
  assert(!party['kol|sales|netpl']['Carbonlite Print & Publishing'],
    'the old spelling is gone from the fold -- it is not a party of its own');
  assert(merged['2024-25'] && merged['2024-25'][7] === 51100,
    'the invoice raised under the old name counts for the merged customer');
  assert(merged['2025-26'] && merged['2025-26'][3] === 40010,
    'and so does the one raised under the current name, a year later');
  const carbonLeaves = leaves(yoy.partyTreeFrom(party['kol|sales|netpl'], xd, fys, 'sales').tree);
  assert(carbonLeaves.filter((x) => /Carbonlite/.test(x)).length === 1,
    'the tree shows the customer once, not once per spelling: ' + JSON.stringify(carbonLeaves.filter((x) => /Carbonlite/.test(x))));

  // ---- a journal with no debtor stays out ----------------------------------
  assert(!party['kol|sales|net']['Salary'] && !party['kol|sales|net']['HDFC Current'],
    'a salary journal reaches neither section -- these are party-anchored, not P&L lines');

  // ---- consolidated re-picks the dominant party ------------------------------
  const sepKol = (party['kol|sales|netpl']['Modern Herbo'] || {})['2024-25'] || [];
  const sepAll = (party['all|sales|netpl']['Modern Herbo'] || {})['2024-25'] || [];
  assert(!zero(sepKol) && !zero(sepAll), 'the branch-settled sale is attributed in both views');
  assert(sepKol[5] === 55000 && sepAll[5] === 55000,
    'the sale settled against the other branch still lands on its debtor, consolidated or not');

  // ---- a one-year rebuild leaves the other year alone -----------------------
  const S2 = yoy.newSummary(xd, aliases);
  for (const v of vouchers) if (v.date >= '20250401') yoy.addVoucher(S2, v);
  const p2 = yoy.partyDetailOf(S2);
  const spliced = yoy.spliceDetail(party['kol|sales|netpl'], p2['kol|sales|netpl'], ['2025-26']);
  assert(JSON.stringify(spliced['Modern Herbo']['2024-25']) === JSON.stringify(party['kol|sales|netpl']['Modern Herbo']['2024-25']),
    'rebuilding one year does not disturb an earlier year of the same customer');
  assert(spliced['Modern Herbo']['2025-26'][1] === 180000, 'and the rescanned year is the fresh figure');

  await browser.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\n== year-on-year Sales Analysis matches the dashboard ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
