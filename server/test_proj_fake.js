// What a customer still owes, when the money came in by a route other than a receipt.
//
// An export invoice at CDC is routinely financed: the bank advances against the bill
// (PCFC / packing credit / bill discounting), the customer's money reaches the bank,
// the loan is knocked off, and a JOURNAL squares the customer. No Receipt voucher is
// ever written. If the receivables engine only believes receipts, that invoice stays
// open for ever and the party reads as owing money it paid months ago -- which is
// exactly what was reported: Tally 6.74 lakh, the portal 17.45 lakh, on an export
// customer settled through a PCFC loan.
//
// So these are the shapes that journal actually takes in the books, and every one of
// them has to come out at the same figure Tally shows. The engine is lifted out of
// portal/index.html and run as-is (see projEngine.js) -- the browser's own code, not a
// copy of it, because a copy would be free to be right here and wrong on screen.
const projEngine = require('./projEngine');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1 : tol);

const eng = projEngine();

// The groups as Tally actually holds them. The two loan ledgers are the point:
//
//   'PCFC Loan 0012' sits under Bank OD A/c -- which is where a packing-credit account
//      normally IS. The extractor files every Bank-OD ledger under party_ledgers, and
//      the group chain says "Loans (Liability) > Bank OD A/c", so a keyword list
//      looking for "pcfc" in the GROUP chain never matches it either. Both halves of
//      the old loan test miss it, which is why the old test had to go.
//   'HDFC Secured Loan' sits under Secured Loans, the shape the old test did catch.
//      It is here so the fix is shown not to have broken it.
const xd = {
  groups: {
    'Current Assets': 'Capital Account',
    'Current Liabilities': 'Capital Account',
    'Loans (Liability)': 'Capital Account',
    'Revenue Account': null,
    'Capital Account': null,
    'Sundry Debtors': 'Current Assets',
    'Sundry Creditors': 'Current Liabilities',
    'Bank Accounts': 'Current Assets',
    'Bank OD A/c': 'Loans (Liability)',
    'Secured Loans': 'Loans (Liability)',
    'Sales Accounts': 'Revenue Account',
    'Indirect Expenses': 'Revenue Account',
    'Branch / Divisions': 'Capital Account',
  },
  ledgers: {
    'Alpha Exports': 'Sundry Debtors',
    'Beta Exports': 'Sundry Debtors',
    'Gamma Trading': 'Sundry Debtors',
    'PCFC Loan 0012': 'Bank OD A/c',
    'HDFC Secured Loan': 'Secured Loans',
    'HDFC Current A/c': 'Bank Accounts',
    'Export Sales': 'Sales Accounts',
    'Exchange Rate Difference': 'Indirect Expenses',
    'Bad Debts Written Off': 'Indirect Expenses',
    'CDC Printers Kolkata': 'Branch / Divisions',
  },
  ids: {},
};
const ib = eng.findIB(xd);
const AS_ON = new Date(2026, 9, 31);   // 31 Oct 2026

// An export invoice: Dr the customer (Tally stores Dr as -ve), Cr Export Sales, with
// the bill reference the invoice opens ("New Ref").
function sale(party, no, date, amt, vt) {
  return { date: date, type: vt || 'Export Sales 26-27', no: no,
    party_ledgers: { [party]: -amt },
    ledgers: { 'Export Sales': amt },
    bills: [{ ledger: party, ref: no, type: 'New Ref', amount: -amt }] };
}
// A journal that squares the customer: Cr the customer (+ve), Dr whatever absorbed it.
// `ref` names the bill it settles, as Tally's "Agst Ref" does.
function jv(party, amt, date, drLedger, drIsParty, ref, vt) {
  const v = { date: date, type: vt || 'Journal', no: 'JV/1',
    party_ledgers: { [party]: amt }, ledgers: {},
    bills: ref ? [{ ledger: party, ref: ref, type: 'Agst Ref', amount: amt }] : [] };
  if (drIsParty) v.party_ledgers[drLedger] = -amt; else v.ledgers[drLedger] = -amt;
  return v;
}
function owed(vouchers, party) {
  const out = eng.buildProjection(vouchers, xd, ib, [], [], AS_ON);
  const row = out.allDebtorBills[party];
  return row ? row.outstanding : null;
}

// ---------------------------------------------------------------------------
// 1. The reported bug, to the rupee it was reported in.
// ---------------------------------------------------------------------------
// 17,45,000 invoiced; 10,71,000 came in through the PCFC loan and was journalled off.
// Tally says 6,74,000 is still open, so the portal has to say 6,74,000.
const pcfc = [
  sale('Alpha Exports', 'EXP/001', '20260601', 1745000),
  jv('Alpha Exports', 1071000, '20260815', 'PCFC Loan 0012', true, 'EXP/001'),
];
assert(near(owed(pcfc, 'Alpha Exports'), 674000),
  'an export invoice settled through a PCFC loan under Bank OD leaves only the UNPAID part open'
  + ' (got ' + owed(pcfc, 'Alpha Exports') + ', Tally says 674000)');

// ---------------------------------------------------------------------------
// 2. The loan shape the old code DID catch still works.
// ---------------------------------------------------------------------------
const secured = [
  sale('Alpha Exports', 'EXP/002', '20260601', 1000000),
  jv('Alpha Exports', 400000, '20260701', 'HDFC Secured Loan', false, 'EXP/002'),
];
assert(near(owed(secured, 'Alpha Exports'), 600000),
  'a loan booked under Secured Loans still knocks the invoice down -- the old case did not regress');

// ---------------------------------------------------------------------------
// 3. The voucher type is not always spelt "Journal".
// ---------------------------------------------------------------------------
// Tally lets a company name its own voucher types, and this file matches sales and
// notes by PREFIX for exactly that reason. An equality test on 'Journal' was the one
// place that did not, so "Journal - Export" fell straight through it.
const renamed = [
  sale('Beta Exports', 'EXP/003', '20260601', 900000),
  jv('Beta Exports', 500000, '20260720', 'PCFC Loan 0012', true, 'EXP/003', 'Journal - Export'),
];
assert(near(owed(renamed, 'Beta Exports'), 400000),
  'a journal named "Journal - Export" settles the bill, like any other journal');

// ---------------------------------------------------------------------------
// 4. The other leg is nobody's idea of a loan.
// ---------------------------------------------------------------------------
// On an export realisation the rupees received differ from the rupees invoiced, and the
// difference goes to exchange fluctuation. Dr Exchange Rate Difference, Cr the customer
// -- a settlement whose contra leg is an expense account. Nothing about the customer's
// balance depends on what the other leg was, and the engine must not care either.
const fx = [
  sale('Gamma Trading', 'EXP/004', '20260601', 500000),
  jv('Gamma Trading', 12000, '20260820', 'Exchange Rate Difference', false, 'EXP/004'),
];
assert(near(owed(fx, 'Gamma Trading'), 488000),
  'a journal whose other leg is exchange difference still reduces what the customer owes');

// A write-off is the same mechanism, and Tally drops the bill from outstanding too: the
// money is gone, but the customer does not owe it any more.
const written = [
  sale('Gamma Trading', 'EXP/005', '20260601', 300000),
  jv('Gamma Trading', 300000, '20260901', 'Bad Debts Written Off', false, 'EXP/005'),
];
assert(near(owed(written, 'Gamma Trading'), 0),
  'a bill written off to bad debts stops being outstanding, as it does in Tally');

// ---------------------------------------------------------------------------
// 5. A journal can go the OTHER way, and then it RAISES the receivable.
// ---------------------------------------------------------------------------
// Interest charged to a customer, or a balance transferred in from another ledger, is
// Dr the customer. The sign says which way; it is not a settlement because it is a
// journal. Reading every journal as a receipt would hide money owed.
const raised = [
  sale('Beta Exports', 'EXP/006', '20260601', 200000),
  { date: '20260901', type: 'Journal', no: 'JV/9',
    party_ledgers: { 'Beta Exports': -50000 },
    ledgers: { 'Exchange Rate Difference': 50000 },
    bills: [{ ledger: 'Beta Exports', ref: 'JV/9', type: 'New Ref', amount: -50000 }] },
];
assert(near(owed(raised, 'Beta Exports'), 250000),
  'a journal that DEBITS the customer raises what it owes, instead of settling anything');

// ---------------------------------------------------------------------------
// 6. The ordinary path must be untouched.
// ---------------------------------------------------------------------------
const plain = [
  sale('Alpha Exports', 'EXP/007', '20260601', 800000),
  { date: '20260715', type: 'Receipt', no: 'RCT/1',
    party_ledgers: { 'Alpha Exports': 300000, 'HDFC Current A/c': -300000 },
    ledgers: {},
    bills: [{ ledger: 'Alpha Exports', ref: 'EXP/007', type: 'Agst Ref', amount: 300000 }] },
];
assert(near(owed(plain, 'Alpha Exports'), 500000),
  'an invoice part-settled by an ordinary Receipt is unchanged by any of this');

// A sale with no settlement at all still reads as fully open.
assert(near(owed([sale('Alpha Exports', 'EXP/008', '20260601', 123456)], 'Alpha Exports'), 123456),
  'an invoice nobody has paid is open for its whole value');

// ---------------------------------------------------------------------------
// 7. The journal settles the bill it NAMES, not merely some bill.
// ---------------------------------------------------------------------------
// Which bill is closed decides the ageing, and the ageing decides when the projection
// expects the money. A journal carrying "Agst Ref" has to be applied to that reference,
// the same way a receipt is.
const twoBills = [
  sale('Gamma Trading', 'EXP/010', '20260401', 100000),
  sale('Gamma Trading', 'EXP/011', '20260901', 700000),
  jv('Gamma Trading', 700000, '20261001', 'PCFC Loan 0012', true, 'EXP/011'),
];
const g = eng.buildProjection(twoBills, xd, ib, [], [], AS_ON).allDebtorBills['Gamma Trading'];
assert(near(g.outstanding, 100000),
  'settling the NEWER bill by journal leaves the older one open, not the other way round');
assert(g.unpaid.length === 1 && g.unpaid[0].ref === 'EXP/010',
  'and the bill still named as unpaid is the one the journal did not mention'
  + ' (got ' + JSON.stringify(g.unpaid.map((u) => u.ref)) + ')');

// ---------------------------------------------------------------------------
// 8. Inter-branch settlement: the other branch collected, the customer is square.
// ---------------------------------------------------------------------------
const crossBranch = [
  sale('Alpha Exports', 'EXP/012', '20260601', 400000),
  jv('Alpha Exports', 400000, '20260810', 'CDC Printers Kolkata', true, 'EXP/012'),
];
assert(near(owed(crossBranch, 'Alpha Exports'), 0),
  'a customer squared off against the other branch owes nothing here either');

// ---------------------------------------------------------------------------
// 9. The uploaded snapshot must not be counted on top of the vouchers that hold it.
// ---------------------------------------------------------------------------
// A bills CSV is what Tally showed open on the day it was printed. The vouchers carry
// bill allocations back to April 2015, so once the loaded window reaches a bill's own
// date, the voucher that RAISED it is in the set and the CSV copy is the same money a
// second time. It doubled exactly 2x -- and doubled whether or not the reference still
// matched, because Tally re-types references and two spellings became two bills.
//
// 6.29 Cr against Tally's ~3.1 on one paper supplier is what this looks like from the
// outside, and no amount of name-merging touches it: nothing is misfiled, one bill is
// simply there twice.
const CREDITOR = 'Paper Supplier';
const xdC = {
  groups: Object.assign({}, xd.groups, { 'Purchase Accounts': 'Revenue Account' }),
  ledgers: Object.assign({}, xd.ledgers, { 'Paper Supplier': 'Sundry Creditors', 'Paper Purchase': 'Purchase Accounts' }),
  ids: {},
};
// A purchase: Cr the supplier (+ve), Dr Purchase, raising bill PUR/100.
const purchase = { date: '20250301', type: 'Purchase', no: 'PUR/100',
  party_ledgers: { [CREDITOR]: 5000000 }, ledgers: { 'Paper Purchase': -5000000 },
  bills: [{ ledger: CREDITOR, ref: 'PUR/100', type: 'New Ref', amount: 5000000 }] };
// The same bill as a 31-Mar-2025 snapshot row.
const snapRow = { date: '20250301', refNo: 'PUR/100', party: CREDITOR, amount: 5000000,
  dueDate: '20250331', overdueDays: 0, isAdvance: false };
function owedC(vouchers, payBills) {
  const o = eng.buildProjection(vouchers, xdC, eng.findIB(xdC), [], payBills, AS_ON);
  const r = o.allCreditorBills[CREDITOR];
  return { amt: r ? Math.round(r.outstanding) : null, dropped: o.openingsDropped };
}
assert(near(owedC([purchase], [snapRow]).amt, 5000000),
  'a bill in BOTH the uploaded snapshot and the vouchers is owed ONCE, not twice'
  + ' (got ' + owedC([purchase], [snapRow]).amt + ')');
const retyped = Object.assign({}, snapRow, { refNo: 'AKT/100' });
assert(near(owedC([purchase], [retyped]).amt, 5000000),
  'and still once when Tally re-typed the reference, so the two spellings cannot become two bills');
assert(owedC([purchase], [snapRow]).dropped.pay === 1,
  'the snapshot row that the vouchers already held is COUNTED as dropped, not silently discarded');

// Where the vouchers do NOT reach, the snapshot is still the only source and must stand.
assert(near(owedC([], [snapRow]).amt, 5000000),
  'with no vouchers at all the uploaded snapshot is still what the party owes');
const laterPurchase = { date: '20250601', type: 'Purchase', no: 'PUR/200',
  party_ledgers: { [CREDITOR]: 1000000 }, ledgers: { 'Paper Purchase': -1000000 },
  bills: [{ ledger: CREDITOR, ref: 'PUR/200', type: 'New Ref', amount: 1000000 }] };
assert(near(owedC([laterPurchase], [snapRow]).amt, 6000000),
  'an opening from BEFORE the window plus this window own invoices adds up, which is the whole design'
  + ' (got ' + owedC([laterPurchase], [snapRow]).amt + ')');
assert(owedC([laterPurchase], [snapRow]).dropped.pay === 0,
  'and nothing is dropped in that case, because the vouchers do not reach back to it');

// The same trap on the receivable side, since both sides take a CSV.
const saleOld = sale('Alpha Exports', 'EXP/900', '20250301', 2000000);
const recvRow = { date: '20250301', refNo: 'EXP/900', party: 'Alpha Exports', amount: 2000000,
  dueDate: '20250331', overdueDays: 0, isAdvance: false };
const bothSides = eng.buildProjection([saleOld], xd, ib, [recvRow], [], AS_ON);
assert(near(bothSides.allDebtorBills['Alpha Exports'].outstanding, 2000000),
  'a receivable bill in both the snapshot and the vouchers is outstanding ONCE as well'
  + ' (got ' + Math.round(bothSides.allDebtorBills['Alpha Exports'].outstanding) + ')');

// ---------------------------------------------------------------------------
// 10. A RETURN booked on a Sales/Purchase voucher type reduces the balance.
// ---------------------------------------------------------------------------
// The sale and purchase paths used to read the posting through Math.abs(), so a return
// posted on a "Purchase ..." or "Sales ..." type was filed as a FRESH INVOICE: wrong by
// TWICE the returned value, once for not subtracting it and once for adding it. A paper
// supplier read 6.29 Cr against Tally's 1.62. Tally's own reports never ask the voucher
// type which way a posting goes, and neither may this.
const purchRet = { date: '20260501', type: 'Purchase Return', no: 'PR/1',
  party_ledgers: { [CREDITOR]: -1000000 }, ledgers: { 'Paper Purchase': 1000000 },
  bills: [{ ledger: CREDITOR, ref: 'PUR/200', type: 'Agst Ref', amount: -1000000 }] };
assert(near(owedC([laterPurchase, purchRet], []).amt, 0),
  'a purchase return on a "Purchase ..." voucher type REDUCES the payable, it does not add an invoice'
  + ' (got ' + owedC([laterPurchase, purchRet], []).amt + ' on a 10 lakh purchase returned in full)');

const bigPurch = { date: '20260401', type: 'Purchase', no: 'PUR/300',
  party_ledgers: { [CREDITOR]: 5000000 }, ledgers: { 'Paper Purchase': -5000000 },
  bills: [{ ledger: CREDITOR, ref: 'PUR/300', type: 'New Ref', amount: 5000000 }] };
const partRet = { date: '20260501', type: 'Purchase Return', no: 'PR/2',
  party_ledgers: { [CREDITOR]: -1000000 }, ledgers: { 'Paper Purchase': 1000000 },
  bills: [{ ledger: CREDITOR, ref: 'PUR/300', type: 'Agst Ref', amount: -1000000 }] };
assert(near(owedC([bigPurch, partRet], []).amt, 4000000),
  'and a partial return leaves the rest payable, not the whole invoice plus the return'
  + ' (got ' + owedC([bigPurch, partRet], []).amt + ', was 6000000 before the sign rule)');

// The same shape on the sales side.
const saleV = sale('Gamma Trading', 'EXP/700', '20260401', 3000000);
const saleRet = { date: '20260501', type: 'Sales Return', no: 'SR/1',
  party_ledgers: { 'Gamma Trading': 500000 }, ledgers: { 'Export Sales': -500000 },
  bills: [{ ledger: 'Gamma Trading', ref: 'EXP/700', type: 'Agst Ref', amount: 500000 }] };
assert(near(owed([saleV, saleRet], 'Gamma Trading'), 2500000),
  'a sales return on a "Sales ..." voucher type reduces what the customer owes'
  + ' (got ' + owed([saleV, saleRet], 'Gamma Trading') + ')');

// A credit note now carries its allocations too, so it reverses the bill it NAMES.
const cnNamed = { date: '20260501', type: 'Credit Note', no: 'CN/1',
  party_ledgers: { 'Gamma Trading': 500000 }, ledgers: { 'Export Sales': -500000 },
  bills: [{ ledger: 'Gamma Trading', ref: 'EXP/700', type: 'Agst Ref', amount: 500000 }] };
assert(near(owed([saleV, cnNamed], 'Gamma Trading'), 2500000),
  'and so does a credit note, which is the same movement under a different voucher type');

// ---------------------------------------------------------------------------
// 11. A ledger RENAMED in Tally is one party, and its money does not vanish.
// ---------------------------------------------------------------------------
// Vouchers keep whatever was typed at the time, so after a rename the older ones carry
// the old spelling. The projection matched names exactly, so the two were two parties --
// and the old one did not merely split off, it DISAPPEARED: a name in no master
// classifies as Unclassified, which is neither a debtor nor a creditor, so its purchases
// left payables altogether while the payments typed under the new name settled nothing.
// The P&L tab, which normalises punctuation, had been counting that ledger correctly the
// whole time, so the two tabs disagreed about whether the money existed.
const AKT_NEW = 'A K Trading Paper pvt ltd';   // what Tally holds now
const AKT_OLD = 'A.K.Trading Paper Pvt.Ltd.';  // what older vouchers say
const xdR = {
  groups: Object.assign({}, xd.groups, { 'Purchase Accounts': 'Revenue Account' }),
  ledgers: { [AKT_NEW]: 'Sundry Creditors', 'Paper Purchase': 'Purchase Accounts', 'HDFC Current A/c': 'Bank Accounts' },
  ids: { [AKT_NEW]: 'guid-akt-0001' },
};
function renameRun(aliasMap, xdUse) {
  const vs = [
    { date: '20260401', type: 'Purchase', no: 'PUR/1',
      party_ledgers: { [AKT_OLD]: 5000000 }, ledgers: { 'Paper Purchase': -5000000 },
      bills: [{ ledger: AKT_OLD, ref: 'PUR/1', type: 'New Ref', amount: 5000000 }] },
    { date: '20260801', type: 'Payment', no: 'PAY/1',
      party_ledgers: { [AKT_NEW]: -3000000, 'HDFC Current A/c': 3000000 }, ledgers: {},
      bills: [{ ledger: AKT_NEW, ref: 'PUR/1', type: 'Agst Ref', amount: -3000000 }] },
  ];
  eng.window.__cdcAliases = aliasMap || {};
  eng.canon(xdUse, vs, null);
  const o = eng.buildProjection(vs, xdUse, eng.findIB(xdUse), [], [], AS_ON);
  const rows = {};
  for (const k in o.allCreditorBills) rows[k] = Math.round(o.allCreditorBills[k].outstanding);
  return rows;
}
const renamed1 = renameRun(null, xdR);
assert(Object.keys(renamed1).length === 1 && near(renamed1[AKT_NEW], 2000000),
  'a ledger renamed in Tally is ONE party with its payment applied, without anybody merging names by hand'
  + ' (got ' + JSON.stringify(renamed1) + ')');
assert(!Object.prototype.hasOwnProperty.call(renamed1, AKT_OLD),
  'and the old spelling is not a second party whose purchases sit there unpaid for ever');

const renamed2 = renameRun({ [AKT_OLD]: AKT_NEW }, xdR);
assert(Object.keys(renamed2).length === 1 && near(renamed2[AKT_NEW], 2000000),
  'an alias the user saved by hand still does exactly the same thing, and still wins');

// SAFETY: two REAL ledgers that differ only in punctuation must not be welded together.
// Both are in the master, so neither name is missing and nothing is guessed at.
const xdTwo = {
  groups: xdR.groups,
  ledgers: { [AKT_NEW]: 'Sundry Creditors', [AKT_OLD]: 'Sundry Creditors',
    'Paper Purchase': 'Purchase Accounts', 'HDFC Current A/c': 'Bank Accounts' },
  ids: { [AKT_NEW]: 'guid-akt-0001', [AKT_OLD]: 'guid-akt-0002' },
};
// Its purchase stays on the OLD ledger's own name and is NOT moved onto the new one,
// so the payment typed against the other ledger does not settle it. That is the right
// answer when both really exist: they are two accounts, and only a human can say
// otherwise -- which is what the alias map is for.
const two = renameRun(null, xdTwo);
assert(near(two[AKT_OLD], 5000000) && !Object.prototype.hasOwnProperty.call(two, AKT_NEW),
  'but two ledgers that BOTH exist in the master stay separate -- punctuation alone never welds them'
  + ' (got ' + JSON.stringify(two) + ')');

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
