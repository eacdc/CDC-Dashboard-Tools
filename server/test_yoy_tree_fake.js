// The year-on-year drill-down: the tree under each line must add up to the line.
//
// test_yoy_fake.js already proves the LINE totals equal what the P&L tab shows, in a
// real browser. So the check that matters here is that opening a line does not
// invent or lose money: for every branch, every line and every year, the accounts in
// the tree have to sum back to that line's total. Anything else -- a ledger dropped
// for landing in no group, a year's slots read at the wrong offset, consolidated
// forgetting to eliminate the branch account -- shows up as a mismatch.
'use strict';
const { summarise, newSummary, addVoucher, finalize, detailOf, spliceDetail, treeFrom, TREE_LINES } = require('./yoySummary');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const near = (a, b) => Math.abs(a - b) < 0.02;

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
let n = 0;
const mk = (branch, date, type, ledgers, party_ledgers) =>
  ({ branch, _branch: branch, date, type, no: 'V' + (++n), ledgers, party_ledgers });

const vouchers = [
  mk('kol', '20240415', 'Sales', { 'Sales - Job Work': 100000 }, { 'Modern Herbo': -100000 }),
  mk('kol', '20240520', 'Sales', { 'Export Sales': 250000 }, { 'Gleebuds': -250000 }),
  mk('kol', '20240610', 'Purchase', { 'Paper Purchase': -60000, 'Freight Inward': -4000 }, { 'Paper Supplier': 64000 }),
  mk('kol', '20241105', 'Journal', { 'Salary': -30000 }, {}),
  mk('kol', '20250310', 'Journal', { 'Bank Charges': -1200 }, {}),
  mk('kol', '20240720', 'Bank Receipt', { 'HDFC Current': -90000 }, { 'Modern Herbo': 90000 }),
  mk('kol', '20240820', 'Bank Payments', { 'HDFC Current': 50000 }, { 'Paper Supplier': -50000 }),
  mk('kol', '20241010', 'Contra', { 'HDFC Current': 20000, 'Petty Cash': -20000 }, {}),
  mk('kol', '20241120', 'Bank Receipt', { 'HDFC Current': -15000 }, { 'CDC Ahmedabad': 15000 }),
  mk('ahm', '20240925', 'Sales', { 'Sales - Job Work': 70000 }, { 'Gleebuds': -70000 }),
  mk('ahm', '20241220', 'Bank Payments', { 'HDFC Current': 12000 }, { 'Paper Supplier': -12000 }),
  mk('kol', '20250510', 'Sales', { 'Sales - Job Work': 180000 }, { 'Modern Herbo': -180000 }),
  mk('kol', '20250612', 'Purchase', { 'Paper Purchase': -75000 }, { 'Paper Supplier': 75000 }),
  mk('kol', '20251115', 'Journal', { 'Salary': -33000 }, {}),
  mk('kol', '20250815', 'Bank Receipt', { 'HDFC Current': -120000 }, { 'Modern Herbo': 120000 }),
  mk('ahm', '20250910', 'Sales', { 'Export Sales': 90000 }, { 'Gleebuds': -90000 }),
];

const S = newSummary(xd);
for (const v of vouchers) addVoucher(S, v);
const summary = finalize(S);
const detail = detailOf(S);
const fys = summary.fys;

// Walk a sparse node and everything under it, adding the slots of one year.
function yearSum(nodes, fyIdx) {
  let t = 0;
  for (const nd of nodes) {
    for (let i = fyIdx * 12; i < fyIdx * 12 + 12; i++) if (nd.m[i]) t += nd.m[i];
  }
  return t;
}
function leaves(nodes, out) {
  out = out || [];
  for (const nd of nodes) {
    if (nd.t === 'l') out.push(nd.n);
    if (nd.c) leaves(nd.c, out);
    if (nd.l) leaves(nd.l, out);
  }
  return out;
}

// ---- the tree adds up to its line, everywhere --------------------------------
let checked = 0, worst = null;
for (const branch of ['kol', 'ahm', 'all']) {
  for (const line of TREE_LINES) {
    const src = branch === 'all'
      ? [detail['kol|' + line] || {}, detail['ahm|' + line] || {}]
      : [detail[branch + '|' + line] || {}];
    const tree = treeFrom(src, xd, fys);
    fys.forEach((fy, fi) => {
      const want = (summary.branches[branch] && summary.branches[branch][fy])
        ? summary.branches[branch][fy].totals[line] : 0;
      const got = Math.round(yearSum(tree, fi) * 100) / 100;
      checked++;
      if (!near(got, want) && !worst) worst = `${branch} ${line} ${fy}: tree ${got} vs line ${want}`;
    });
  }
}
assert(!worst, `every branch/line/year tree adds up to its line total (${checked} checks)` + (worst ? ' -- ' + worst : ''));
assert(checked === 3 * TREE_LINES.length * fys.length, `all ${3 * TREE_LINES.length * fys.length} combinations were compared`);

// ---- shape ------------------------------------------------------------------
const revKol = treeFrom([detail['kol|revenue']], xd, fys);
const revLeaves = leaves(revKol);
assert(revLeaves.includes('Sales - Job Work') && revLeaves.includes('Export Sales'),
  'revenue opens down to the individual sales ledgers');
assert(JSON.stringify(revKol).includes('Sales Accounts'),
  'and they sit under their Tally group, not loose at the top');
const salary = leaves(treeFrom([detail['kol|indirectExp']], xd, fys));
assert(salary.includes('Salary') && salary.includes('Bank Charges'), 'indirect expenses list their own ledgers');
const cashOutAll = leaves(treeFrom([detail['kol|cashOut'], detail['ahm|cashOut']], xd, fys));
assert(cashOutAll.includes('Paper Supplier'), 'the cash lines open down to the party paid');

// ---- consolidated drops the branch account ----------------------------------
const cashInKol = leaves(treeFrom([detail['kol|cashIn']], xd, fys));
const cashInAll = leaves(treeFrom([detail['kol|cashIn'], detail['ahm|cashIn']], xd, fys));
assert(cashInKol.includes('CDC Ahmedabad'), 'the inter-branch receipt is a real inflow for Kolkata');
assert(!cashInAll.includes('CDC Ahmedabad'), 'and is eliminated from consolidated, as in the totals');

// ---- sparseness is worth having ---------------------------------------------
const flatSize = JSON.stringify(treeFrom([detail['kol|cashIn']], xd, fys)).length;
assert(flatSize > 0 && !JSON.stringify(revKol).includes('null'), 'trees serialise without holes');
const anyNode = revKol[0];
assert(anyNode && typeof anyNode.m === 'object' && !Array.isArray(anyNode.m),
  'months travel as { slot: amount }, not a fully-written array');

// ---- a partial rebuild replaces only its own years ---------------------------
const first = fys[0], second = fys[1];
const prev = detail['kol|revenue'];
assert(prev['Sales - Job Work'][first] && prev['Sales - Job Work'][second],
  'the fixture has this ledger in both years, so the splice has something to get wrong');

// Rescan the SECOND year only, with the sales figure changed.
const S2 = newSummary(xd);
for (const v of vouchers) if (v.date >= second.slice(0, 4) + '0401') addVoucher(S2, v);
const d2 = detailOf(S2);
d2['kol|revenue']['Sales - Job Work'][second] = d2['kol|revenue']['Sales - Job Work'][second].map((x) => x * 2);
const spliced = spliceDetail(prev, d2['kol|revenue'], [second]);
assert(JSON.stringify(spliced['Sales - Job Work'][first]) === JSON.stringify(prev['Sales - Job Work'][first]),
  'the untouched year survives a one-year rebuild untouched');
assert(spliced['Sales - Job Work'][second][1] === prev['Sales - Job Work'][second][1] * 2,
  'and the rescanned year takes the new figures');

// A ledger that lost every voucher in the rescanned year must go, not linger.
const gone = spliceDetail({ 'Ghost Ledger': { [second]: new Array(12).fill(0).map((_, i) => (i === 0 ? 5 : 0)) } }, {}, [second]);
assert(!gone['Ghost Ledger'], 'a ledger emptied by the rescan disappears instead of keeping its old figures');

// ---- summarise() still returns the light summary -----------------------------
const light = summarise(vouchers, xd);
assert(!light.trees && !light.detail, 'the landing-page summary carries no tree -- it stays small');

console.log(fails ? `\n${fails} check(s) FAILED` : '\n== year-on-year trees add up ==');
process.exit(fails ? 1 : 0);
