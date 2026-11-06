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

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
