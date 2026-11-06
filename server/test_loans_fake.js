// Loan movement: opening, drawdowns, repayments, closing -- and the one property that
// makes the statement worth anything, that each period's closing IS the next period's
// opening. If that ever stops holding, every figure on the page is decoration.
//
// No database: the arithmetic lives in loanMovement.js precisely so it can be driven
// directly. The endpoint is a thin adapter over this.
const LM = require('./loanMovement');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.5 : tol);

// ---------------------------------------------------------------------------
// Which ledgers are borrowings
// ---------------------------------------------------------------------------
const chainOf = {
  'PCFC Loan 0012': ['Capital Account', 'Loans (Liability)', 'Bank OD A/c'],
  'HDFC CC A/c': ['Capital Account', 'Loans (Liability)', 'Bank OCC A/c'],
  'HDFC Term Loan': ['Capital Account', 'Loans (Liability)', 'Secured Loans'],
  'Director Loan': ['Capital Account', 'Loans (Liability)', 'Unsecured Loans'],
  'Buyers Credit SBI': ['Capital Account', 'Current Liabilities'],
  'Staff Loan Given': ['Capital Account', 'Current Assets', 'Loans & Advances (Asset)'],
  'HDFC Current A/c': ['Capital Account', 'Current Assets', 'Bank Accounts'],
  'Term Loan Interest': ['Revenue Account', 'Indirect Expenses'],
  'A Customer': ['Capital Account', 'Current Assets', 'Sundry Debtors'],
};
const kind = (n) => LM.loanKind(n, chainOf[n]);
assert(kind('PCFC Loan 0012') === 'od_cc',
  'a packing-credit account under Bank OD A/c IS a borrowing, which is where Tally puts one');
assert(kind('HDFC CC A/c') === 'od_cc', 'and so is a cash-credit account under Bank OCC');
assert(kind('HDFC Term Loan') === 'term', 'a term loan under Secured Loans is a TERM loan');
assert(kind('Director Loan') === 'unsecured', 'a director loan under Unsecured Loans is an unsecured one');
assert(kind('Buyers Credit SBI') === 'other',
  'a facility filed straight under Current Liabilities is still counted, by its name');
assert(kind('Staff Loan Given') === null,
  'but money WE lent out is not a borrowing, however much the word "loan" is in it');
assert(kind('HDFC Current A/c') === null, 'a bank current account is the other side of a repayment, not a loan');
assert(kind('Term Loan Interest') === null,
  'and "Term Loan Interest" is an expense -- a report that turned it into a borrowing would be worse than none');
assert(kind('A Customer') === null, 'a customer is not a loan');
assert(LM.nearMiss('Term Loan Interest', chainOf['Term Loan Interest']) === true,
  'a ledger NAMED like a loan but grouped elsewhere is reported as a near miss, because a loan silently absent from a loan report is the one error nobody would spot');

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------
assert(LM.bucketKeyOf('20261106', 'month') === '202611', 'a month bucket is keyed YYYYMM');
assert(LM.weekStart('20261106') === '20261102',
  'a week runs Monday to Sunday, so Friday 6 Nov 2026 belongs to the week of Monday the 2nd');
assert(LM.weekStart('20261102') === '20261102', 'and a Monday is its own week start');
assert(LM.weekStart('20261101') === '20261026',
  'while Sunday 1 Nov belongs to the week before, not the one starting the next day');
assert(LM.bucketsBetween('20260401', '20260630', 'month').join(',') === '202604,202605,202606',
  'every month in the window is present, including ones with no movement at all');
assert(LM.bucketsBetween('20260401', '20260407', 'day').length === 7, 'a day bucket per day, inclusive of both ends');

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------
const meta = {
  'PCFC Loan 0012': { kind: 'od_cc', group: 'Loans (Liability) > Bank OD A/c', branches: ['kol'] },
  'HDFC Term Loan': { kind: 'term', group: 'Loans (Liability) > Secured Loans', branches: ['kol'] },
};
// Tally's openings stand on 1 Apr 2025: PCFC 40 lakh drawn, term loan 1 crore.
// Cr-positive, as masters.opening stores a liability.
const openings = { kol: { asOn: '20250401', amounts: { 'PCFC Loan 0012': 4000000, 'HDFC Term Loan': 10000000 } } };
const rows = [
  // FY 2025-26, before the window we will ask about
  { ledger: 'PCFC Loan 0012', branch: 'kol', date: '20250610', drawn: 1000000, repaid: 0 },
  { ledger: 'HDFC Term Loan', branch: 'kol', date: '20250610', drawn: 0, repaid: 2000000 },
  // the window: April 2026 onward
  { ledger: 'PCFC Loan 0012', branch: 'kol', date: '20260410', drawn: 2500000, repaid: 0 },
  { ledger: 'PCFC Loan 0012', branch: 'kol', date: '20260610', drawn: 0, repaid: 1500000 },
  { ledger: 'HDFC Term Loan', branch: 'kol', date: '20260505', drawn: 0, repaid: 1000000 },
];
const rep = LM.buildLoanMovement({ ledgerMeta: meta, openings, rows, from: '20260401', to: '20260630', bucket: 'month' });

// Opening at 1 Apr 2026 = Tally's 1 Apr 2025 opening + everything posted in between.
const pcfc = rep.loans.find((l) => l.ledger === 'PCFC Loan 0012');
const term = rep.loans.find((l) => l.ledger === 'HDFC Term Loan');
assert(near(pcfc.opening, 5000000),
  'the opening at the window start is Tally own opening PLUS the postings since that day: 40L + 10L drawn = 50L'
  + ' (got ' + pcfc.opening + ')');
assert(near(term.opening, 8000000),
  'and a repayment in between REDUCES it: 1 Cr - 20L repaid = 80L (got ' + term.opening + ')');
assert(near(pcfc.drawn, 2500000) && near(pcfc.repaid, 1500000),
  'drawdowns and repayments inside the window are counted on their own, not netted');
assert(near(pcfc.closing, 6000000),
  'closing = opening + drawn - repaid: 50L + 25L - 15L = 60L (got ' + pcfc.closing + ')');
assert(near(rep.total.opening, 13000000) && near(rep.total.closing, 13000000 + 2500000 - 2500000),
  'the totals are the sum of the loans, so the header cannot disagree with the rows under it');

// THE property: closing carries forward.
let broke = null;
for (const l of rep.loans) {
  for (let i = 1; i < l.periods.length; i++) {
    if (!near(l.periods[i].opening, l.periods[i - 1].closing)) broke = `${l.ledger} at ${l.periods[i].key}`;
  }
  if (!near(l.periods[0].opening, l.opening)) broke = `${l.ledger} first period`;
  if (!near(l.periods[l.periods.length - 1].closing, l.closing)) broke = `${l.ledger} last period`;
}
assert(!broke, 'every period closing IS the next period opening, for every loan (' + (broke || 'held') + ')');
let brokeAll = null;
for (let i = 1; i < rep.periods.length; i++) {
  if (!near(rep.periods[i].opening, rep.periods[i - 1].closing)) brokeAll = rep.periods[i].key;
}
assert(!brokeAll, 'and it holds for all borrowings combined too (' + (brokeAll || 'held') + ')');

// Each period's figures are the ledgers' own, summed.
const may = rep.periods.find((p) => p.key === '202605');
assert(near(may.repaid, 1000000) && near(may.drawn, 0),
  'May 2026 shows the term-loan repayment and nothing drawn, as the rows say');
const june = rep.periods.find((p) => p.key === '202606');
assert(near(june.repaid, 1500000), 'and June shows the PCFC repayment');

// A quiet period still appears, carrying the balance.
const rep2 = LM.buildLoanMovement({ ledgerMeta: meta, openings, rows, from: '20260701', to: '20260930', bucket: 'month' });
assert(rep2.periods.length === 3 && rep2.periods.every((p) => p.drawn === 0 && p.repaid === 0),
  'a window with no movement at all still lists its months');
assert(near(rep2.periods[2].closing, rep2.total.opening),
  'and carries the balance through them unchanged, which is what somebody checking a quiet quarter wants to see');
assert(near(rep2.total.opening, 13000000 + 2500000 - 2500000),
  'its opening is the previous window closing: the statement is continuous across windows (got ' + rep2.total.opening + ')');

// ---------------------------------------------------------------------------
// A drawdown and a repayment on the SAME day must both survive
// ---------------------------------------------------------------------------
// This is how an OD account actually behaves, and netting them would report a day of
// heavy churn as a day on which nothing happened.
const sameDay = LM.buildLoanMovement({
  ledgerMeta: { 'HDFC CC A/c': { kind: 'od_cc', group: 'Bank OCC A/c', branches: ['kol'] } },
  openings: { kol: { asOn: '20260401', amounts: { 'HDFC CC A/c': 0 } } },
  rows: [
    { ledger: 'HDFC CC A/c', branch: 'kol', date: '20260415', drawn: 900000, repaid: 0 },
    { ledger: 'HDFC CC A/c', branch: 'kol', date: '20260415', drawn: 0, repaid: 400000 },
  ],
  from: '20260401', to: '20260430', bucket: 'day',
});
const d15 = sameDay.periods.find((p) => p.key === '20260415');
assert(near(d15.drawn, 900000) && near(d15.repaid, 400000),
  'a drawdown and a repayment on one day are both shown, not netted into one figure');
assert(near(d15.closing, 500000), 'and the day closes at the net of the two');

// ---------------------------------------------------------------------------
// No openings pulled yet: movement, and SAID to be movement
// ---------------------------------------------------------------------------
const noOpen = LM.buildLoanMovement({
  ledgerMeta: meta, openings: { kol: { asOn: null, amounts: {} } }, rows,
  from: '20260401', to: '20260630', bucket: 'month',
});
assert(noOpen.openingKnown.kol === false,
  'with no opening balances pulled, the report SAYS so rather than presenting movement as a balance');
assert(near(noOpen.loans.find((l) => l.ledger === 'PCFC Loan 0012').opening, 1000000),
  'and the opening it does show is only the movement it holds from before the window (got '
  + noOpen.loans.find((l) => l.ledger === 'PCFC Loan 0012').opening + ')');

// ---------------------------------------------------------------------------
// A window that starts BEFORE the openings stand
// ---------------------------------------------------------------------------
// Tally's opening already contains everything up to its own day, so a posting inside the
// window but before that day must come OFF the opening and show as movement where it
// happened -- otherwise it is counted twice and the closing is wrong by that much.
const early = LM.buildLoanMovement({
  ledgerMeta: { 'HDFC Term Loan': meta['HDFC Term Loan'] },
  openings: { kol: { asOn: '20250401', amounts: { 'HDFC Term Loan': 10000000 } } },
  rows: [{ ledger: 'HDFC Term Loan', branch: 'kol', date: '20250215', drawn: 0, repaid: 500000 }],
  from: '20250101', to: '20250630', bucket: 'month',
});
assert(near(early.total.opening, 10500000),
  'a repayment dated before the opening day is taken back OFF the opening, so the window starts where it really started'
  + ' (got ' + early.total.opening + ', expected 1.05 Cr before the 5L repayment)');
assert(near(early.periods.find((p) => p.key === '202502').repaid, 500000),
  'and it appears as movement in February, where it happened');
assert(near(early.total.closing, 10000000),
  'leaving the closing at Tally own opening figure, which is the only answer that can be right');

// ---------------------------------------------------------------------------
// Grouping and ordering
// ---------------------------------------------------------------------------
assert(rep.byKind.length === 2 && rep.byKind.every((k) => k.kindLabel && k.count === 1),
  'borrowings are totalled by kind, each kind labelled for a human');
assert(near(rep.byKind.reduce((s, k) => s + k.closing, 0), rep.total.closing),
  'and the kinds add back to the grand total');
assert(rep.loans[0].ledger === 'HDFC Term Loan',
  'the biggest balance is listed first, so a page of dormant accounts cannot bury the ones that matter');

// ---------------------------------------------------------------------------
// Accrued interest is not a borrowing, however its ledger is named
// ---------------------------------------------------------------------------
// Straight from the live books: "Interest on Term Loan Payable" and "Interest on PCRE
// Loan Payable" sit under Current Liabilities > Liability for Expenses. The name rule
// caught them because they say "Term Loan" and "PCRE Loan". They were nil in the window
// they were spotted in, so they distorted nothing -- and would have the moment interest
// was accrued.
const accrual = ['Capital Account', 'Current Liabilities', 'Liability for Expenses'];
assert(LM.loanKind('Interest on Term Loan Payable', accrual) === null,
  'accrued interest on a term loan is interest owed, not money borrowed');
assert(LM.loanKind('Interest on PCRE Loan Payable', accrual) === null,
  'and the same for accrued interest on a PCRE loan');
assert(LM.loanKind('Interest Receivable on PCRE Loan', ['Capital Account', 'Current Assets']) === null,
  'interest RECEIVABLE is not a borrowing either, it is the other way round entirely');
// The name exclusions must only ever block the NAME path -- a ledger the GROUP says is a
// loan stays one, whatever words are in it.
assert(LM.loanKind('L/C Payable to Muller Martini', ['Capital Account', 'Loans (Liability)', 'Secured Loans']) === 'term',
  'but a real facility under Secured Loans is untouched by the word "payable" in its name');
assert(LM.loanKind('Loan From Director - Manu Choudhury',
  ['Capital Account', 'Loans (Liability)', 'Unsecured Loans', 'Loan From Director']) === 'unsecured',
  'and a director loan nested two groups deep is still an unsecured borrowing');

// ---------------------------------------------------------------------------
// An OD sweeps: its gross is turnover, not borrowing
// ---------------------------------------------------------------------------
// The live figures were 204 Cr drawn against 169 Cr repaid on ONE OD account over seven
// months -- 223 Cr of a 277 Cr "drawn" headline -- which buried the 54 Cr of real new
// facilities. The headline therefore separates facilities from the OD's net move, and the
// split has to reconcile to the same closing as the gross does.
const sw = LM.buildLoanMovement({
  ledgerMeta: {
    'Citi Bank OD': { kind: 'od_cc', group: 'Bank OD A/c', branches: ['kol'] },
    'Term Loan A': { kind: 'term', group: 'Secured Loans', branches: ['kol'] },
  },
  openings: { kol: { asOn: '20260401', amounts: { 'Citi Bank OD': 50000000, 'Term Loan A': 20000000 } } },
  rows: [
    // the OD, churning: 30 Cr through it either way, net +5 Cr
    { ledger: 'Citi Bank OD', branch: 'kol', date: '20260410', drawn: 300000000, repaid: 0 },
    { ledger: 'Citi Bank OD', branch: 'kol', date: '20260420', drawn: 0, repaid: 250000000 },
    // a real facility: 10 Cr drawn, 1 Cr repaid
    { ledger: 'Term Loan A', branch: 'kol', date: '20260505', drawn: 100000000, repaid: 0 },
    { ledger: 'Term Loan A', branch: 'kol', date: '20260510', drawn: 0, repaid: 10000000 },
  ],
  from: '20260401', to: '20260531', bucket: 'month',
});
assert(sw.total.drawnFacility === 100000000 && sw.total.repaidFacility === 10000000,
  'the headline counts only the real facility drawn and repaid (got '
  + sw.total.drawnFacility + ' / ' + sw.total.repaidFacility + ')');
assert(sw.total.sweepNet === 50000000 && sw.total.sweepAccounts === 1,
  'the OD contributes ONE net figure instead of 55 Cr of turnover in both directions');
assert(sw.total.drawn === 400000000, 'the gross is still there for anyone who asks for it');
assert(near(sw.total.opening + sw.total.drawnFacility - sw.total.repaidFacility + sw.total.sweepNet,
  sw.total.closing),
  'and the split reconciles to the same closing as the gross: opening + facilities drawn - repaid + OD net');
assert(sw.loans.find((l) => l.ledger === 'Citi Bank OD').sweep === true
  && sw.loans.find((l) => l.ledger === 'Term Loan A').sweep === false,
  'each account says whether it sweeps, so the page does not have to guess from its name');
assert(near(sw.total.sweepOpening, 50000000) && near(sw.total.sweepClosing, 100000000),
  'and the OD accounts own opening and closing are carried, because that is the figure that matters on them');
let swBroke = null;
for (let i = 0; i < sw.periods.length; i++) {
  const p = sw.periods[i];
  if (!near(p.opening + p.drawnFacility - p.repaidFacility + p.sweepNet, p.closing)) swBroke = p.key;
}
assert(!swBroke, 'every period reconciles on the split too (' + (swBroke || 'held') + ')');

// ---------------------------------------------------------------------------
// A loan closing in DEBIT is reported as such
// ---------------------------------------------------------------------------
// Live: three Citi term loans repaid 1.75x to 2.33x their opening and closed negative,
// and two PCFC accounts carried negative openings with no movement at all. Negative on
// this scale means more was repaid than the account held -- which is usually a gap in the
// vouchers between the opening's own day and the window start, not a fact about the loan.
const debit = LM.buildLoanMovement({
  ledgerMeta: { 'Term Loan 221780001': { kind: 'term', group: 'Secured Loans', branches: ['kol'] } },
  openings: { kol: { asOn: '20260401', amounts: { 'Term Loan 221780001': 1034482.55 } } },
  rows: [{ ledger: 'Term Loan 221780001', branch: 'kol', date: '20260610', drawn: 0, repaid: 2413793.13 }],
  from: '20260401', to: '20260630', bucket: 'month',
});
assert(debit.inDebit.length === 1 && debit.inDebit[0].ledger === 'Term Loan 221780001',
  'a loan repaid past zero is NAMED as being in debit, rather than left as a minus sign to notice');
assert(near(debit.inDebit[0].closing, -1379310.58),
  'with the figure it closed at, so it can be put straight beside Tally (got ' + debit.inDebit[0].closing + ')');
assert(debit.loans[0].inDebit === true, 'and the row carries the flag for the page to mark');

// Dormant accounts are counted, so a page can hide them and say how many it hid. The
// live books carry 133 borrowing ledgers of which about 120 are long closed.
const dorm = LM.buildLoanMovement({
  ledgerMeta: {
    'Live Loan': { kind: 'term', group: 'Secured Loans', branches: ['kol'] },
    'Closed Lender A': { kind: 'unsecured', group: 'Unsecured Loans', branches: [] },
    'Closed Lender B': { kind: 'unsecured', group: 'Unsecured Loans', branches: [] },
  },
  openings: { kol: { asOn: '20260401', amounts: { 'Live Loan': 5000000 } } },
  rows: [{ ledger: 'Live Loan', branch: 'kol', date: '20260410', drawn: 0, repaid: 1000000 }],
  from: '20260401', to: '20260430', bucket: 'month',
});
assert(dorm.dormant === 2,
  'accounts with no balance and no movement are counted, so they can be hidden without being dropped');
assert(dorm.loans.length === 3, 'but they are all still returned -- hiding is the page figuring, not the data');

// ---------------------------------------------------------------------------
// The opening's two halves, because one figure cannot say which is wrong
// ---------------------------------------------------------------------------
// Live: the April 2026 OD opening came out at 79.74 Cr against Tally's 19.40, while
// unsecured loans matched to the rupee. Those two facts together say the mechanism works
// and one input does not -- but a single opening figure cannot say whether the master's
// own opening is wrong or whether vouchers between its day and April are missing. So the
// halves are reported separately.
const halves = LM.buildLoanMovement({
  ledgerMeta: { 'Citi OD': { kind: 'od_cc', group: 'Bank OD A/c', branches: ['kol'] } },
  openings: { kol: { asOn: '20250401', amounts: { 'Citi OD': 10000000 } } },
  rows: [
    { ledger: 'Citi OD', branch: 'kol', date: '20250801', drawn: 50000000, repaid: 0 },
    { ledger: 'Citi OD', branch: 'kol', date: '20251201', drawn: 0, repaid: 20000000 },
    { ledger: 'Citi OD', branch: 'kol', date: '20260510', drawn: 0, repaid: 5000000 },
  ],
  from: '20260401', to: '20260531', bucket: 'month',
});
const hp = halves.loans[0].openingParts;
assert(near(hp.tally, 10000000),
  "the Tally half is the master's own opening balance, untouched (got " + hp.tally + ')');
assert(near(hp.postings, 30000000),
  'the postings half is what we added between that day and the window start (got ' + hp.postings + ')');
assert(near(hp.tally + hp.postings, halves.loans[0].opening),
  'and the two halves are exactly the opening, so neither is a separate estimate');
assert(near(halves.total.openingParts.tally, 10000000) && near(halves.total.openingParts.postings, 30000000),
  'the totals carry the same split, so a headline that disagrees with Tally can be read the same way');

// ---------------------------------------------------------------------------
// Export credit is its own kind, not a flavour of secured debt
// ---------------------------------------------------------------------------
// Tally files PCFC and PCRE under Secured Loans because they ARE secured -- but a packing
// credit drawn against one shipment and repaid when that shipment realises answers a
// different question from a seven-year loan on a printing press, and adding them up
// answers neither. These are the real chains out of the live chart of accounts.
const EX = (n, g) => LM.loanKind(n, g.split('>'));
assert(EX('PCRE Loan with Citi Bank - A/c No.R0226A1904', 'Loans (Liability)>Secured Loans>PCRE Loan Citi Bank') === 'export',
  'a PCRE account under its own sub-group is EXPORT credit, not a term loan');
assert(EX('PCFC Loan with ICICI Bank - A/c No.000653000231', 'Loans (Liability)>Secured Loans>PCFC Loan ICICI Bank') === 'export',
  'and so is a PCFC account');
assert(EX('PCFC Loan 9912', 'Loans (Liability)>Secured Loans') === 'export',
  'and so is one filed straight under Secured Loans, because the NAME says PCFC and the group chain never carries it');
assert(EX('Term Loan with Citi Bank - A/c No 242060001', 'Loans (Liability)>Secured Loans') === 'term',
  'while a term loan under the same group stays a TERM loan -- which is the whole point of splitting them');
assert(EX('Packing Credit SBI', 'Capital Account>Current Liabilities') === 'export',
  'a packing credit filed loosely under Current Liabilities is still export credit');
assert(EX("Buyer's Credit SBI", 'Capital Account>Current Liabilities') === 'other',
  "but buyer's credit finances IMPORTS, so it is not export credit");
assert(EX('Citi Bank, (Kolkata)', 'Loans (Liability)>Bank OD A/c') === 'od_cc',
  'an OD account keeps its own kind whatever facility it funds, because it is reported by its balance');
assert(LM.nearMiss('PCFC Settlement Suspense', ['Capital Account', 'Suspense A/c']) === true,
  'and a PCFC-named ledger outside every loan group is a NEAR MISS, named rather than dropped');

// The sections come back in a fixed order, short-term first.
const ordered = LM.buildLoanMovement({
  ledgerMeta: {
    'T': { kind: 'term', group: 'Secured Loans', branches: ['kol'] },
    'E': { kind: 'export', group: 'Secured Loans > PCRE', branches: ['kol'] },
    'O': { kind: 'od_cc', group: 'Bank OD A/c', branches: ['kol'] },
    'U': { kind: 'unsecured', group: 'Unsecured Loans', branches: ['kol'] },
  },
  openings: { kol: { asOn: '20260401', amounts: { T: 100, E: 9999999, O: 50, U: 10 } } },
  rows: [], from: '20260401', to: '20260430', bucket: 'month',
});
assert(ordered.byKind.map((k) => k.kind).join(',') === 'od_cc,export,term,unsecured',
  'kinds are listed short-term first in a FIXED order, not by size -- a summary that reorders itself'
  + ' between loads is one nobody learns to read (got ' + ordered.byKind.map((k) => k.kind).join(',') + ')');
assert(ordered.byKind.every((k) => k.kindLabel && k.kindLabel !== k.kind),
  'and every kind carries a label written for a human, not its internal name');

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
