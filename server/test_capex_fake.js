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

  // AN ADVANCE GROUP IS RECOGNISED BY THE WORD "MACHINERY", not by an exact phrase.
  const hdl = (j.cashRows || []).find((r) => /Heidelberger/.test(r.paidFor));
  assert(hdl && hdl.amount === 28200000 && hdl.kind === 'advance',
    'an advance paid into a group called "Advance for Machinery" is capex cash -- requiring'
    + ' the words "plant & machinery" missed every rupee of it');
  assert((j.cashRows || []).some((r) => /Gaiapac/.test(r.paidFor)),
    'and so is one paid to a ledger named only after the supplier, because the GROUP says'
    + ' what the money is for');
  // A SUPPLIER IS WHOEVER ACTUALLY SOLD US A MACHINE, not whoever is filed under a group
  // that says so. Names and groups run out; the purchase voucher does not.
  const bob = (j.cashRows || []).find((r) => /Bobst/.test(r.paidFor));
  assert(bob && bob.amount === 4000000 && bob.kind === 'supplier',
    'paying a supplier filed under ORDINARY Sundry Creditors is still capex cash when that'
    + ' supplier sold us a fixed asset in this window -- evidence, not vocabulary');
  assert(j.capexPartyGroups.some((x) => x.kind === 'supplier' && /Sundry Creditors/.test(x.group)),
    'and the page says it was recognised that way rather than by its group');
  assert((j.advanceGroups || []).some((x) => /Loans & Advances/.test(x.group) && !x.counted),
    'while an advance account that says nothing about machinery is LISTED as not counted,'
    + ' so money left out of the figure is visible instead of silently missing');
  assert((j.advanceGroups || []).some((x) => /Advance for Machinery/.test(x.group) && x.counted),
    'and one that is counted is marked as such');

  // A PARTY IS NOT A CATEGORY. A freight forwarder whose charges on one import were
  // capitalised into a machine is not thereby a machinery supplier, and its ordinary
  // invoices are not capex. The bill reference is exact where the party is not.
  const emi = (j.cashRows || []).filter((r) => /Emirates/.test(r.paidFor));
  assert(emi.length === 1 && emi[0].amount === 150000,
    'only the payment settling the bill the asset was actually bought on counts -- not the'
    + ' freight forwarder\'s other invoices (got ' + emi.length + ' row(s) totalling '
    + emi.reduce((t, r) => t + r.amount, 0) + ')');
  assert(!(j.cashRows || []).some((r) => r.amount === 4200183 || r.amount === 2915864),
    'an ordinary freight payment against its own bill is NOT capex cash, and neither is one'
    + ' that names no bill at all');
  assert(j.unmatchedSupplier >= 4200183 + 2915864 - 1,
    'what was paid to such a party against other bills is TOTALLED, so money deliberately'
    + ' left out of the figure is visible rather than silently dropped (got '
    + j.unmatchedSupplier + ')');
  // And the rule must not throw out the case it was built for.
  const bob2 = (j.cashRows || []).find((r) => /Bobst/.test(r.paidFor));
  assert(bob2 && bob2.amount === 4000000,
    'a supplier that really did sell us a machine is still counted, because the payment'
    + ' settles the very bill the machine was bought on');

  // CASH OUT ON CAPEX -- a different question from what was capitalised, and the one
  // that matters for a cash-flow view.
  const cash = j.cashRows || [];
  const adv = cash.find((r) => /Komori/.test(r.paidFor));
  assert(adv && adv.amount === 15000000 && adv.kind === 'advance',
    'an ADVANCE against a machine is cash out on capex the day it is paid, months before the'
    + ' asset exists -- it does not wait for the machine to be capitalised');
  const settle = cash.find((r) => r.date === '20260828');
  assert(settle && near(settle.amount, 2110443.65),
    'a payment run that settles one machinery bill and one paper advance contributes ONLY the'
    + ' machine, because the capex DEBITS are read rather than the bank total (got '
    + (settle && settle.amount) + ')');
  const direct = cash.find((r) => r.paidFor === 'Computers');
  assert(direct && direct.amount === 500000 && direct.kind === 'asset',
    'and an asset paid for straight out of the bank is cash out on the day it is paid');
  assert(near(j.cashOut, 15000000 + 2110443.65 + 2110443.65 + 500000 + 1500000
      + 28200000 + 6926000 + 4000000 + 150000),
    'the total is every one of those and nothing else -- no capitalisation journal, no'
    + ' supplier bill that has not been paid, and no disposal netted off (got ' + j.cashOut + ')');
  assert(!cash.some((r) => r.amount < 0),
    'and SELLING an asset is not negative capex spend: proceeds from scrapping old laptops'
    + ' do not quietly net a disposal into the money gone out');
  assert(!cash.some((r) => r.date === '20260515'),
    'the day a press is CAPITALISED against a term loan no money moves, so it is not cash out');
  assert(j.capexPartyGroups.some((x) => /Sundry Creditor - Fixed Assets/.test(x.group) && x.kind === 'capital_creditor')
    && j.capexPartyGroups.some((x) => /Capital Advances/.test(x.group) && x.kind === 'advance'),
    'and the accounts the cash is followed through are NAMED, because this rests entirely on'
    + ' how the chart of accounts is laid out and a missing one is money left out in silence');
  assert(!j.capexPartyGroups.some((x) => /Loans & Advances/.test(x.group)),
    'a general supplier-advance account is NOT guessed at: it carries paper as well as'
    + ' machinery, and no rule here can split it');

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

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall good');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
