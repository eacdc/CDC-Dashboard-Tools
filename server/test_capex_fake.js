// Capex: what was spent on fixed assets, when, on what, and how it was paid for.
//
// The thing that makes this report honest is the distinction it refuses to blur. An
// addition is recorded the day the asset is CAPITALISED; the money may have left earlier
// (an advance), later (a creditor), or over five years (a term loan on the machine). So
// every row says how it was funded. "Capex in terms of cash flow" without that reads a
// press bought on finance as crores of cash gone in a day.
//
// And a disposal is never netted against a purchase: a year that bought 2 Cr of plant and
// sold 1 Cr of it did not spend 1 Cr.

function valueAt(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
  return cur;
}
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = valueAt(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$ne' in cond && val === cond.$ne) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async findOne(filter = {}) { return this.docs.find((d) => matches(d, filter)) || null; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, project() { return this; },
      batchSize() { return this; }, async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
  }
  aggregate() { return { async toArray() { return []; } }; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.PORT = '0';
const app = require('./server');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= 0.5;

let n = 0;
// The extractor stores the narration inside `details`, NOT at the top level of the
// voucher -- so a fixture that sets a top-level `narration` would pass against code
// that reads a field no real voucher has. It is written where Tally's own pull puts it.
const V = (branch, date, pl, ld, extra) => {
  const ex = { ...(extra || {}) };
  const narr = ex.narration; delete ex.narration;
  const ref = ex.reference; delete ex.reference;
  return {
    _id: branch + ':' + (++n), guid: 'g' + n, branch, date, no: 'V' + n,
    type: 'Purchase', party: '',
    details: { narration: narr || '', reference: ref || '' },
    party_ledgers: pl || {}, ledgers: ld || {}, ...ex,
  };
};

(async () => {
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: {
      'Heidelberg CD102 Press': 'Plant & Machinery',
      'Factory Building': 'Buildings',
      'Computers': 'Office Equipment',
      'New Line CWIP': 'Capital Work In Progress',
      'Accumulated Depreciation': 'Plant & Machinery',   // filed under the asset, NOT a purchase
      'Depreciation': 'Indirect Expenses',
      'Paper Purchase': 'Purchase Accounts',
      'HDFC Current A/c': 'Bank Accounts',
      'Machine Supplier': 'Sundry Creditors',
      // The trap: Kolkata files the SUPPLIERS of its machines under a creditor sub-group
      // whose own name says "Fixed Assets". It is a payable, not an asset.
      'Robotjet Co.Ltd.': 'Sundry Creditor - Fixed Assets',
      'Advance for Capital Goods - Komori': 'Capital Advances',
      // Ahmedabad's real shape: a group called "Advance for Machinery" holding one
      // ledger per supplier, named after the supplier and saying nothing about machines.
      'Heidelberger Druckmaschinen Aktiengesellschaft': 'Advance for Machinery',
      'Gaiapac Middle East FZ-LLC- Rigid Box Machine': 'Advance for Machinery',
      // A machinery supplier filed in the ORDINARY creditors group -- nothing in its
      // name or its group says machine, and only the purchase itself proves what it is.
      'Bobst India Pvt Ltd': 'Sundry Creditors',
      // A FREIGHT FORWARDER. Its charges on one import were capitalised into a machine,
      // which is correct accounting -- and is NOT a reason to call its every invoice capex.
      'Emirates Logistics India Private Limited': 'Sundry Creditors',
      // A BINDING-MACHINE MAKER under the ordinary creditors group. Nothing but its own
      // name says what it sells, and its machine is still being paid for in instalments,
      // so no purchase voucher exists to learn from either.
      'Pinghu Bindex Machinery Co.,Ltd.': 'Sundry Creditors',
      // The two things the name rule must NOT sweep in with it.
      'Machinery Spare Parts Co': 'Sundry Creditors',
      'Machine Oil & Lubricants Ltd': 'Sundry Creditors',
      'Advance to Suppliers': 'Loans & Advances',
      'Digital Book Edge Printer': 'Plant & Machinery',
      // The Ahmedabad factory: accumulated in WIP while it was built, then capitalised.
      'WIP - Factory Building': 'Preoperating Block',
      'WIP - Plant & Machinary': 'Preoperating Block',
      'Ahmedabad Factory Building': 'Buildings',
      'HDFC Term Loan': 'Secured Loans',
      'Repairs to Machinery': 'Indirect Expenses',
    },
    groups: {
      'Plant & Machinery': 'Fixed Assets', 'Buildings': 'Fixed Assets',
      'Office Equipment': 'Fixed Assets', 'Fixed Assets': 'Capital Account',
      'Capital Work In Progress': 'Capital Account',
      'Preoperating Block': 'Fixed Assets',
      'Bank Accounts': 'Current Assets', 'Current Assets': 'Capital Account',
      'Sundry Creditors': 'Current Liabilities', 'Current Liabilities': 'Capital Account',
      'Sundry Creditor - Fixed Assets': 'Sundry Creditors',
      'Capital Advances': 'Current Assets', 'Loans & Advances': 'Current Assets',
      'Advance for Machinery': 'Current Assets',
      'Secured Loans': 'Loans (Liability)', 'Loans (Liability)': 'Capital Account',
      'Indirect Expenses': 'Revenue Account', 'Purchase Accounts': 'Revenue Account',
      'Capital Account': null, 'Revenue Account': null,
    },
    ids: {},
  });

  const vs = fakeDb.collection('vouchers').docs;
  // -ve = Dr = the asset went UP. Paid straight from the bank.
  vs.push(V('kol', '20260410', { 'HDFC Current A/c': 500000 }, { 'Computers': -500000 },
    { type: 'Payment', narration: '12 workstations' }));
  // A press on a term loan: the money does NOT leave today.
  vs.push(V('kol', '20260515', {}, { 'Heidelberg CD102 Press': -50000000, 'HDFC Term Loan': 50000000 },
    { type: 'Journal', narration: 'CD102 capitalised, funded by Citi term loan' }));
  // A building on credit from a supplier.
  vs.push(V('kol', '20260620', { 'Machine Supplier': 2000000 }, { 'Factory Building': -2000000 },
    { type: 'Purchase', party: 'Machine Supplier' }));
  // Capital work in progress is capex too.
  vs.push(V('kol', '20260705', { 'HDFC Current A/c': 1500000 }, { 'New Line CWIP': -1500000 }));
  // A DISPOSAL: the asset is credited. Never netted into spend.
  vs.push(V('kol', '20260810', { 'HDFC Current A/c': -300000 }, { 'Computers': 300000 },
    { type: 'Journal', narration: 'old laptops sold' }));
  // Things that must NOT count:
  vs.push(V('kol', '20260815', {}, { 'Depreciation': -900000, 'Accumulated Depreciation': 900000 },
    { type: 'Journal' }));
  vs.push(V('kol', '20260816', { 'HDFC Current A/c': 40000 }, { 'Repairs to Machinery': -40000 }));
  vs.push(V('kol', '20260817', { 'Machine Supplier': 100000 }, { 'Paper Purchase': -100000 }));
  // ONE MACHINE BOUGHT FROM A SUPPLIER FILED UNDER "Sundry Creditor - Fixed Assets".
  // Three vouchers, and before the ancestry rule each of them produced a capex row:
  // the purchase (right), the payment that settled it (a second "purchase"), and the
  // exchange difference on it. The purchase voucher also credits the creditor, which
  // read as a DISPOSAL of the same amount as the asset.
  vs.push(V('kol', '20260820', { 'Robotjet Co.Ltd.': 2132900 }, { 'Digital Book Edge Printer': -2132900 },
    { type: 'Purchase - Fixed Assets', party: 'Robotjet Co.Ltd.', narration: 'Digital Book Edge Printer' }));
  vs.push(V('kol', '20260825', { 'Robotjet Co.Ltd.': -2110443.65, 'HDFC Current A/c': 2110443.65 },
    {}, { type: 'Bank Payments', party: 'Robotjet Co.Ltd.' }));
  vs.push(V('kol', '20260826', { 'Robotjet Co.Ltd.': -22456.35 }, { 'Repairs to Machinery': 22456.35 },
    { type: 'Journal', party: 'Robotjet Co.Ltd.' }));

  // CAPITALISATION. One journal credits every work-in-progress ledger the factory was
  // accumulated in and debits the finished building. Nothing was bought; nothing was sold.
  vs.push(V('kol', '20260801', {},
    { 'Ahmedabad Factory Building': -70000000,
      'WIP - Factory Building': 60000000, 'WIP - Plant & Machinary': 10000000 },
    { type: 'Journal', narration: 'Being the Factory Building under Construction now Capitalised' }));

  // AN ADVANCE AGAINST A MACHINE IS CASH OUT ON CAPEX, months before the asset exists.
  vs.push(V('kol', '20260505', { 'HDFC Current A/c': 15000000, 'Advance for Capital Goods - Komori': -15000000 },
    {}, { type: 'Bank Payments', narration: '30pc advance, Komori proforma' }));
  // A payment run that settles ONE machinery bill and one paper bill contributes only
  // the machine -- which is why the DEBITS are read, not the bank total.
  vs.push(V('kol', '20260828', { 'HDFC Current A/c': 2600000, 'Robotjet Co.Ltd.': -2110443.65,
    'Machine Supplier': -0.01, 'Advance to Suppliers': -489556.34 },
    {}, { type: 'Bank Payments', narration: 'Robotjet + paper advance' }));

  // AN ADVANCE GROUP THAT SAYS "MACHINERY" BUT NOT "PLANT & MACHINERY". Requiring the
  // exact phrase missed this entirely, and with it 5.23 Cr paid against proformas --
  // nearly all of the capex cash on these books, since machines are paid for long before
  // any creditor is touched.
  vs.push(V('kol', '20260506', { 'HDFC Current A/c': 28200000,
    'Heidelberger Druckmaschinen Aktiengesellschaft': -28200000 }, {},
    { type: 'Bank Payments', narration: 'advance against Heidelberg proforma' }));
  vs.push(V('kol', '20260507', { 'HDFC Current A/c': 6926000,
    'Gaiapac Middle East FZ-LLC- Rigid Box Machine': -6926000 }, {},
    { type: 'Bank Payments', narration: 'advance, rigid box line' }));
  // A MACHINE BOUGHT FROM A SUPPLIER IN THE ORDINARY CREDITORS GROUP, then paid. Neither
  // the name nor the group says machinery; only the purchase proves it.
  vs.push(V('kol', '20260610', { 'Bobst India Pvt Ltd': 4000000 },
    { 'Factory Building': -4000000 },
    { type: 'Purchase - Fixed Assets', party: 'Bobst India Pvt Ltd', narration: 'folder gluer',
      bills: [{ ledger: 'Bobst India Pvt Ltd', ref: 'BOB/FG/88', type: 'New Ref', amount: 4000000 }] }));
  vs.push(V('kol', '20260710', { 'HDFC Current A/c': 4000000, 'Bobst India Pvt Ltd': -4000000 }, {},
    { type: 'Bank Payments', narration: 'paid Bobst',
      bills: [{ ledger: 'Bobst India Pvt Ltd', ref: 'BOB/FG/88', type: 'Agst Ref', amount: -4000000 }] }));

  // THE FREIGHT FORWARDER. One of its bills was capitalised into the gluer's cost; the
  // rest are ordinary import freight on paper. Before the bill rule, the first voucher
  // made it a "machinery supplier" and every payment below counted as capex -- ten
  // ordinary payments, 1.76 Cr of it, none of it capital.
  vs.push(V('kol', '20260612', { 'Emirates Logistics India Private Limited': 150000 },
    { 'Factory Building': -150000 },
    { type: 'Purchase - Fixed Assets', party: 'Emirates Logistics India Private Limited',
      narration: 'clearing on the gluer',
      bills: [{ ledger: 'Emirates Logistics India Private Limited', ref: 'EMI/CAP/7',
                type: 'New Ref', amount: 150000 }] }));
  vs.push(V('kol', '20260620', { 'HDFC Current A/c': 150000,
      'Emirates Logistics India Private Limited': -150000 }, {},
    { type: 'Payment', narration: 'paid the clearing bill on the gluer',
      bills: [{ ledger: 'Emirates Logistics India Private Limited', ref: 'EMI/CAP/7',
                type: 'Agst Ref', amount: -150000 }] }));
  vs.push(V('kol', '20260722', { 'HDFC Current A/c': 4200183,
      'Emirates Logistics India Private Limited': -4200183 }, {},
    { type: 'Payment', narration: 'Ref Bill No.Mention In Voucher',
      bills: [{ ledger: 'Emirates Logistics India Private Limited', ref: 'EMI/PAPER/311',
                type: 'Agst Ref', amount: -4200183 }] }));
  vs.push(V('kol', '20260804', { 'HDFC Current A/c': 2915864,
      'Emirates Logistics India Private Limited': -2915864 }, {},
    { type: 'Payment', narration: 'Ref Bill No.Mention In Voucher' }));

  // Instalments on a machine that has not arrived, to a supplier in no capex group and
  // with no purchase voucher anywhere. Only the company's own name says what it sells.
  vs.push(V('kol', '20260520', { 'HDFC Current A/c': 9000000,
    'Pinghu Bindex Machinery Co.,Ltd.': -9000000 }, {},
    { type: 'Bank Payments', narration: '2nd instalment, perfect binder' }));
  // Spares and oil from suppliers whose names also say machine. Not capex.
  vs.push(V('kol', '20260521', { 'HDFC Current A/c': 125000,
    'Machinery Spare Parts Co': -125000 }, {}, { type: 'Bank Payments' }));
  vs.push(V('kol', '20260522', { 'HDFC Current A/c': 64000,
    'Machine Oil & Lubricants Ltd': -64000 }, {}, { type: 'Bank Payments' }));

  // Drafts reach no figure here either.
  vs.push(V('kol', '20260818', {}, { 'Computers': -7777777, 'HDFC Term Loan': 7777777 }, { cancelled: true }));
  vs.push(V('kol', '20260819', {}, { 'Computers': -8888888, 'HDFC Term Loan': 8888888 }, { optional: true }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await (await fetch(base + p)).json());

  assert((await get('/api/capex?branch=kol')).ok === false,
    'a window is required rather than guessed at');
  const back = await get('/api/capex?branch=kol&from=20260630&to=20260401');
  assert(back.ok === false && /before/.test(back.error || ''),
    'and a window that ends before it starts is refused');

  const j = await get('/api/capex?branch=kol&from=20260401&to=20260831');
  assert(j.ok === true, 'the capex list answers');

  const assets = [...new Set(j.rows.filter((r) => r.spend > 0).map((r) => r.asset))].sort();
  assert(assets.join(' | ') === 'Computers | Digital Book Edge Printer | Factory Building'
    + ' | Heidelberg CD102 Press | New Line CWIP',
    'every fixed-asset purchase is listed, capital work in progress included: got ' + assets.join(' | '));
  assert(!j.rows.some((r) => r.asset === 'Depreciation' || r.asset === 'Repairs to Machinery'),
    'depreciation and repairs are expenses, not capex -- writing an asset down is not buying one');
  assert(!j.rows.some((r) => r.asset === 'Accumulated Depreciation'),
    'and accumulated depreciation filed UNDER the asset group is excluded by name');
  assert(!j.rows.some((r) => r.asset === 'Paper Purchase'), 'a raw-material purchase is not capex');

  assert(near(j.additions, 60282900),
    'additions are the sum of what was capitalised: 5L + 5 Cr + 20L + 15L + the 21.33L printer'
    + ' + the 40L gluer + the 1.5L clearing capitalised into it (got ' + j.additions + ')');
  assert(near(j.disposals, 300000) && near(j.net, 59982900),
    'a disposal is reported APART and never netted into spend -- a year that bought 2 Cr and sold 1 Cr'
    + ' did not spend 1 Cr (got disposals ' + j.disposals + ', net ' + j.net + ')');
  assert(j.rows.every((r) => r.spend < 7000000 || r.asset === 'Heidelberg CD102 Press'),
    'a cancelled or optional voucher reaches no figure here either');

  // A GROUP THAT MENTIONS FIXED ASSETS IS NOT ONE. Everything under Sundry Creditors is
  // a payable however its sub-group is named, and reading it as an asset counted one
  // machine up to four times.
  assert(!j.rows.some((r) => r.asset === 'Robotjet Co.Ltd.'),
    'a SUPPLIER filed under "Sundry Creditor - Fixed Assets" is a payable, not an asset --'
    + ' its name never appears in the Item column');
  const printer = j.rows.filter((r) => r.asset === 'Digital Book Edge Printer' || r.disposal === 2132900);
  assert(printer.length === 1 && printer[0].spend === 2132900,
    'so one machine is ONE row of 21,32,900 -- not the asset leg plus the creditor leg as a'
    + ' disposal plus the bank payment as a second purchase (got ' + printer.length + ' row(s))');
  assert(!j.rows.some((r) => r.disposal === 2132900),
    'and crediting the SUPPLIER when the machine is bought is not a disposal of the machine');
  assert(j.excludedGroups.some((x) => /Sundry Creditor - Fixed Assets/.test(x.group)),
    'the group that was dropped is NAMED, so a real asset group filed somewhere unusual is'
    + ' visible on the page rather than discovered a year later');

  // MONEY MOVING BETWEEN TWO ASSET ACCOUNTS IS NEITHER A PURCHASE NOR A SALE. Read leg by
  // leg, capitalising the Ahmedabad factory was a 7 Cr "disposal" of machines nobody sold
  // AND 7 Cr of assets bought -- the building and everything in it counted twice, once as
  // the WIP leaving and once as the building arriving.
  assert(near(j.additions, 60282900) && near(j.disposals, 300000),
    'capitalising work in progress adds nothing to what was bought and nothing to what was'
    + ' sold (got additions ' + j.additions + ', disposals ' + j.disposals + ')');
  assert(near(j.moved, 140000000),
    'it is reported as money MOVED between asset accounts -- both sides, so 7 Cr out and 7 Cr'
    + ' in (got ' + j.moved + ')');
  const cap = j.rows.filter((r) => r.moved > 0);
  assert(cap.length === 3 && cap.every((r) => r.spend === 0 && r.disposal === 0),
    'every leg of it is a transfer and none of them is a purchase or a disposal');
  assert(cap.filter((r) => r.movedOut).length === 2
    && cap.find((r) => r.asset === 'Ahmedabad Factory Building').movedOut === false,
    'the WIP accounts are what it came OUT of and the finished building is what it went INTO');
  assert(!j.byAsset.some((x) => /^WIP/.test(x.label) && x.spend),
    'and no work-in-progress account appears in what was bought');

  // AN ADVANCE GROUP IS RECOGNISED BY THE WORD "MACHINERY", not by an exact phrase --
  // requiring `plant & machinery` missed `Advance for Machinery` entirely, and with it the
  // one party question this endpoint still asks.
  assert((j.advanceGroups || []).some((x) => /Loans & Advances/.test(x.group) && !x.counted),
    'while an advance account that says nothing about machinery is LISTED as not counted,'
    + ' so money left out of the figure is visible instead of silently missing');
  assert((j.advanceGroups || []).some((x) => /Advance for Machinery/.test(x.group) && x.counted),
    'and one that is counted is marked as such');

  // HOW THE ENTRY WAS BOOKED -- which says nothing about when the money moved.
  const press = j.rows.find((r) => r.asset === 'Heidelberg CD102 Press');
  assert(press && press.funded === 'loan',
    'a press capitalised against a term loan is marked as LOAN funded, not as cash gone that day');
  const pcs = j.rows.find((r) => r.asset === 'Computers' && r.spend > 0);
  assert(pcs && pcs.funded === 'cash', 'a purchase paid straight from the bank is marked cash');
  const bld = j.rows.find((r) => r.asset === 'Factory Building');
  assert(bld && bld.funded === 'credit', 'and one taken on supplier credit is marked credit');
  const fundMap = {};
  for (const f of j.byFunding) fundMap[f.key] = f.spend;
  assert(near(fundMap.loan, 50000000) && near(fundMap.cash, 2000000) && near(fundMap.credit, 8282900),
    'and the booking split totals back: 5 Cr against a loan leg, 20L against a bank leg, 20L +'
    + ' the printer against a supplier account (got ' + JSON.stringify(fundMap) + ')');

  // The rollups.
  const grp = {};
  for (const g of j.byGroup) grp[g.label] = g.spend;
  assert(near(grp['Capital Account > Fixed Assets > Plant & Machinery'], 52132900),
    'spend rolls up by the asset group Tally files it under');
  assert(j.byMonth.map((m) => m.key).join(',') === '202604,202605,202606,202607,202608',
    'and by month, in order, so a spending pattern is visible: got ' + j.byMonth.map((m) => m.key).join(','));
  assert(near(j.byMonth.reduce((s, m) => s + m.spend, 0), j.additions),
    'every rollup adds back to the same total');
  assert(j.byAsset[0].label === 'Heidelberg CD102 Press',
    'the biggest item is named first, because that is the one anybody asks about');

  // Each row carries what it takes to find the entry in Tally.
  assert(press.date === '20260515' && press.no && press.type === 'Journal' && /CD102/.test(press.narration),
    'each row carries the date, voucher number, type and narration -- enough to open it in Tally');
  assert(press.guid === 'g2',
    'and the voucher guid, so the row can link straight at the entry');
  // The narration lives at details.narration. Reading a top-level `narration` returned
  // undefined for every voucher ever stored, so the column shipped blank on every row.
  const bought = j.rows.filter((r) => r.spend > 0 || r.disposal > 0);
  assert(bought.filter((r) => r.narration).length === 6,
    'the narration is read from where the extractor puts it (details.narration), not from a'
    + ' top-level field no voucher has -- got ' + bought.filter((r) => r.narration).length + ' of 6');
  const cwip = j.rows.find((r) => r.asset === 'New Line CWIP');
  assert(cwip && cwip.narration === '',
    'and an entry Tally carries no narration for comes back empty rather than undefined');

  // A floor, for a year of small tools nobody wants listed.
  const big = await get('/api/capex?branch=kol&from=20260401&to=20260831&min=1000000');
  assert(big.rows.filter((r) => r.spend > 0).length === 5 && near(big.additions, 59632900),
    'a minimum drops the small stuff from the list AND from the total, so the two always agree');

  // ==========================================================================
  // CAPEX FOR THE PERIOD: assets capitalised + rise in advances - rise in what is owed.
  // The whole point is that it asks nothing about WHICH supplier sells machines -- the
  // judgement that has been wrong in both directions -- and that an advance and the
  // machine it pays for cannot be counted twice. Followed over one machine's whole life,
  // in three separate windows, which is the only way to prove the second claim.
  // ==========================================================================
  fakeDb.collection('masters').docs.length = 0;
  fakeDb.collection('vouchers').docs.length = 0;
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: { 'Kolbus Binding Line': 'Plant & Machinery',
      'Advance for Machinery - Kolbus': 'Capital Advances',
      'Kolbus GmbH': 'Sundry Creditor - Fixed Assets',
      'HDFC Current A/c': 'Bank Accounts' },
    groups: { 'Plant & Machinery': 'Fixed Assets', 'Fixed Assets': 'Capital Account',
      'Capital Advances': 'Current Assets', 'Current Assets': 'Capital Account',
      'Sundry Creditor - Fixed Assets': 'Sundry Creditors',
      'Sundry Creditors': 'Current Liabilities', 'Current Liabilities': 'Capital Account',
      'Bank Accounts': 'Current Assets', 'Capital Account': null },
    ids: {},
  });
  const V2 = fakeDb.collection('vouchers').docs;
  // Year 1: a 3 Cr advance against the proforma. No machine yet.
  V2.push(V('kol', '20240610', { 'HDFC Current A/c': 30000000,
    'Advance for Machinery - Kolbus': -30000000 }, {}, { type: 'Bank Payments' }));
  // Year 2: the machine lands at 5 Cr. The advance is adjusted; 2 Cr is still owed.
  V2.push(V('kol', '20250815', { 'Advance for Machinery - Kolbus': 30000000,
    'Kolbus GmbH': 20000000 }, { 'Kolbus Binding Line': -50000000 },
    { type: 'Purchase - Fixed Assets' }));
  // Year 3: the balance is paid.
  V2.push(V('kol', '20260910', { 'HDFC Current A/c': 20000000, 'Kolbus GmbH': -20000000 },
    {}, { type: 'Bank Payments' }));

  const flow = async (f, t) => (await get(`/api/capex?branch=kol&from=${f}&to=${t}`)).capexFlow;
  const y1 = await flow('20240401', '20250331');
  const y2 = await flow('20250401', '20260331');
  const y3 = await flow('20260401', '20270331');

  assert(near(y1.additions, 0) && near(y1.advanceNet, 30000000) && near(y1.total, 30000000),
    'the year an advance is paid and no machine arrives, capex is the advance: 3 Cr (got '
    + JSON.stringify(y1) + ')');
  assert(near(y2.additions, 50000000) && near(y2.advanceNet, -30000000) && near(y2.total, 20000000),
    'the year the 5 Cr machine ARRIVES, only the 2 Cr NOT already advanced is new capex --'
    + ' the advance falls by the 3 Cr counted last year and cancels that much of it. This is'
    + ' the double count the whole measure exists to prevent (got ' + JSON.stringify(y2) + ')');
  assert(near(y3.total, 0),
    'and the year the supplier is PAID nothing is added, because the machine was counted'
    + ' when it arrived: this is capex committed, not a bank statement (got ' + y3.total + ')');
  assert(near(y1.total + y2.total + y3.total, 50000000),
    'so over the machine\'s whole life the three periods still add up to exactly what it'
    + ' cost: ' + (y1.total + y2.total + y3.total));

  const whole = await flow('20240401', '20270331');
  assert(near(whole.total, 50000000),
    'and one window covering all three answers the same, because the advance and the bill'
    + ' both open and close inside it');

  // ==========================================================================
  fakeDb.collection('masters').docs.length = 0;
  fakeDb.collection('vouchers').docs.length = 0;
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: { 'Stahl Folder': 'Plant & Machinery',
      'Advance for Machinery - Heidelberg': 'Capital Advances',
      'HDFC Current A/c': 'Bank Accounts' },
    groups: { 'Plant & Machinery': 'Fixed Assets', 'Fixed Assets': 'Capital Account',
      'Capital Advances': 'Current Assets', 'Current Assets': 'Capital Account',
      'Bank Accounts': 'Current Assets', 'Capital Account': null },
    ids: {},
  });
  const V3 = fakeDb.collection('vouchers').docs;
  const ADV = 'Advance for Machinery - Heidelberg';
  // Two proformas paid: 40 L in April, 60 L in May.
  V3.push(V('kol', '20260405', { 'HDFC Current A/c': 4000000, [ADV]: -4000000 }, {},
    { type: 'Bank Payments', narration: 'advance, folder' }));
  V3.push(V('kol', '20260510', { 'HDFC Current A/c': 6000000, [ADV]: -6000000 }, {},
    { type: 'Bank Payments', narration: 'advance, second machine' }));
  // The FIRST machine lands in July: 40 L of the advance is capitalised into it.
  V3.push(V('kol', '20260715', { [ADV]: 4000000 }, { 'Stahl Folder': -4000000 },
    { type: 'Journal', narration: 'folder capitalised against advance' }));

  // ==========================================================================
  // THE OTHER COMPANY IS NOT A SUPPLIER, and a monthly consumable in a machinery group
  // is not a machine. Both found by reading the page's own output against itself: a die
  // cutter Ahmedabad bought and then sent to Kolkata was counted twice, and a stitching
  // wire supplier had over a crore of "capex" without one asset to show for it.
  // ==========================================================================
  fakeDb.collection('masters').docs.length = 0;
  fakeDb.collection('vouchers').docs.length = 0;
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: { 'Fixed Assets 2026-27 (Die Cutter)': 'Gross Block (Plant & Machinery)',
      'CDC Printers Pvt.Ltd.(Ahmedabad)': 'Branch / Divisions',
      'Taiyebji Wires Pvt Ltd': 'Sundry Creditor - Machinery',
      'Smitkal Machinery Co.': 'Sundry Creditor - Machinery',
      'HDFC Current A/c': 'Bank Accounts' },
    groups: { 'Gross Block (Plant & Machinery)': 'Gross Block', 'Gross Block': 'Fixed Assets',
      'Fixed Assets': 'Capital Account',
      'Branch / Divisions': 'Capital Account',
      'Sundry Creditor - Machinery': 'Sundry Creditors',
      'Sundry Creditors': 'Current Liabilities', 'Current Liabilities': 'Capital Account',
      'Bank Accounts': 'Current Assets', 'Current Assets': 'Capital Account',
      'Capital Account': null },
    ids: {},
  });
  const V4 = fakeDb.collection('vouchers').docs;
  // A real purchase from a real machine supplier.
  V4.push(V('kol', '20260423', { 'Smitkal Machinery Co.': 780000 },
    { 'Fixed Assets 2026-27 (Die Cutter)': -780000 },
    { type: 'Purchase - Fixed Assets', party: 'Smitkal Machinery Co.', narration: 'platen die cutter' }));
  // The SAME machine, taken in from the other company months later.
  V4.push(V('kol', '20260930', { 'CDC Printers Pvt.Ltd.(Ahmedabad)': 703798 },
    { 'Fixed Assets 2026-27 (Die Cutter)': -703798 },
    { type: 'Purchase - Fixed Assets', party: 'CDC Printers Pvt.Ltd.(Ahmedabad)',
      narration: 'Used Platen Die Cutting Machine Transfered from Ahmedabad Branch' }));
  // Stitching wire, every month, from a supplier in the machinery creditors group.
  for (const d of ['20260410', '20260510', '20260610']) {
    V4.push(V('kol', d, { 'HDFC Current A/c': 1000000, 'Taiyebji Wires Pvt Ltd': -1000000 }, {},
      { type: 'Bank Payments', narration: 'Ref Bill No.TWP2627' }));
  }

  // ...and paid for, so the control case below is a real one rather than a party with
  // no payments at all.
  V4.push(V('kol', '20260520', { 'HDFC Current A/c': 780000, 'Smitkal Machinery Co.': -780000 }, {},
    { type: 'Bank Payments', narration: 'paid Smitkal' }));

  const ibJ = await get('/api/capex?branch=kol&from=20260401&to=20261031');
  assert(near(ibJ.additions, 780000),
    'a machine taken in from our OTHER company is not a group purchase -- the group owned it'
    + ' the day before, and counting it would put the same die cutter in twice (got '
    + ibJ.additions + ')');
  assert(near(ibJ.interBranchTotal, 703798)
    && (ibJ.rows || []).some((r) => r.interBranch && /Transfered from Ahmedabad/.test(r.narration)),
    'it is listed apart instead, with the voucher, so nothing goes missing in silence');
  assert(!(ibJ.byAsset || []).some((x) => x.spend > 780000),
    'and no rollup carries it either, or the page would disagree with its own total');


  // ==========================================================================
  // AS THE BALANCE SHEET SHOWS IT. Tally already answers "what have we paid for machines
  // that have not come" -- it is the closing balance of the advance accounts under
  // Current Assets. Rebuilding that from the payments inside a window can only ever see
  // the window; the balance carries everything.
  // ==========================================================================
  fakeDb.collection('masters').docs.length = 0;
  fakeDb.collection('vouchers').docs.length = 0;
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: { 'Advance for Machinery - Bindex': 'Capital Advances',
      'Plant': 'Plant & Machinery', 'Depreciation': 'Indirect Expenses',
      'Accumulated Depreciation': 'Plant & Machinery',
      'HDFC Current A/c': 'Bank Accounts' },
    groups: { 'Capital Advances': 'Current Assets', 'Plant & Machinery': 'Fixed Assets',
      'Fixed Assets': 'Capital Account', 'Current Assets': 'Capital Account',
      'Indirect Expenses': 'Revenue Account', 'Bank Accounts': 'Current Assets',
      'Capital Account': null, 'Revenue Account': null },
    ids: {},
    // Tally-raw: an asset carries a Dr, which is -ve. 2 Cr still out against machines.
    closing: { 'Advance for Machinery - Bindex': -20000000 },
    closingAsOn: '20261031',
  });
  const V5 = fakeDb.collection('vouchers').docs;
  // Only 50 L of that was paid inside the window; the rest went out years earlier.
  V5.push(V('kol', '20260615', { 'HDFC Current A/c': 5000000,
    'Advance for Machinery - Bindex': -5000000 }, {}, { type: 'Bank Payments' }));
  // A depreciation charge: an expense, never capex, but it belongs beside the additions.
  V5.push(V('kol', '20260930', {}, { 'Depreciation': -1750000, 'Accumulated Depreciation': 1750000 },
    { type: 'Journal', narration: 'depreciation for the period' }));

  const bs = await get('/api/capex?branch=kol&from=20260401&to=20261031');
  assert(near(bs.advanceOutstanding.total, 20000000),
    'what is still out against machines that have not come is TALLY\'S OWN closing balance'
    + ' -- 2 Cr, not the 50 L that happens to have been paid inside this window (got '
    + bs.advanceOutstanding.total + ')');
  assert(bs.advanceOutstanding.asOn === '20261031',
    'and it is dated, because a balance means nothing without the day it stands on');
  assert(near(bs.depreciation, 1750000),
    'depreciation for the period is reported beside the additions, the way a balance sheet'
    + ' reads (got ' + bs.depreciation + ')');
  assert(near(bs.additions, 0) && !(bs.rows || []).some((r) => /Depreciation/.test(r.asset)),
    'but it is NOT capex and reaches no addition: writing an asset down is not buying one');
  assert(!(bs.rows || []).some((r) => r.disposal > 0),
    'and crediting accumulated depreciation is not a disposal of the machine either');

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall good');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
