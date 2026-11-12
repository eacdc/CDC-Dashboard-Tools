'use strict';
// The trial balance arithmetic and its rules, driven directly: no database, no network.
const T = require('./trialBalance');
// ingest.js opens the database on load; this suite never touches one.
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { getDb: async () => { throw new Error('no database in this suite'); }, close: async () => {}, DB_NAME: 'test' } };
const { cleanSnapshots } = require('./ingest');

let fails = 0;
const assert = (c, m) => { if (c) console.log('ok  - ' + m); else { console.log('FAIL: ' + m); fails++; } };
const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= 0.01;

// ---------------------------------------------------------------------------
// WHICH VOUCHERS POST is decided by the reserved type at the root of the chain.
// ---------------------------------------------------------------------------
{
  const vt = { 'Sales': '', 'Sales Order': 'Sales Order', 'Journal': '', 'Payroll': '',
    'Purchase - Fixed Assets': 'Purchase', 'Purchase': '',
    'SO - Export': 'Sales Order', 'Proforma': 'SO - Export', 'Memo Entry': 'Memorandum', 'Memorandum': '' };
  assert(T.baseType('Purchase - Fixed Assets', vt) === 'Purchase', 'a renamed voucher type is walked back to the type it was created from');
  assert(T.baseType('Proforma', vt) === 'Sales Order', 'through as many levels as it takes');
  assert(T.postsToBooks('Purchase - Fixed Assets', vt).posts === true, 'a purchase under any name posts to the books');
  assert(T.postsToBooks('Proforma', vt).posts === false,
    'a type created from Sales Order posts NOTHING, though its name says nothing of the kind');
  assert(T.postsToBooks('Memo Entry', vt).posts === false, 'a memorandum under another name is still outside the books');
  assert(T.postsToBooks('Payroll', vt).posts === true,
    'payroll POSTS -- it debits salaries and credits what is payable -- whatever the receivables code does with it');
  const g = T.postsToBooks('Sales Order - Old', vt);
  assert(g.posts === false && g.how === 'name',
    'a type the master no longer holds is judged by its name, and SAID to have been');
  assert(T.postsToBooks('Sales', null).how === 'name', 'with no master at all every verdict is a guess from the name, and marked as one');
  const loop = { A: 'B', B: 'A' };
  assert(typeof T.baseType('A', loop) === 'string', 'a master that loops on itself ends the walk instead of hanging it');
}

// ---------------------------------------------------------------------------
// WHICH PERIOD ANSWERS FOR A DATE.
// ---------------------------------------------------------------------------
{
  const snaps = [{ from: '20190401', to: '20200331' }, { from: '20250401', to: '20260331' }, { from: '20260401', to: '20261110' }];
  assert(T.pickSnapshot(snaps, '20190930').from === '20190401', 'a date is answered by the period it falls in');
  assert(T.pickSnapshot(snaps, '20261231').from === '20260401',
    'a date after the last pull but inside the same financial year is still that period\'s');
  assert(T.pickSnapshot(snaps, '20210615') === null,
    'a date in a year with no stored balances gets NO answer -- not 2019-20\'s opening pressed into service');
  assert(T.pickSnapshot(snaps, '20180101') === null, 'nor does a date before every stored period');
  assert(T.pickSnapshot(snaps, '20270401') === null, 'nor one past the end of the newest period\'s year');
  assert(T.fyEndOf('20190401') === '20200331' && T.fyLabel('20190401') === '2019-20', 'a period starting 1 April 2019 is FY 2019-20, ending 31 March 2020');
}

// ---------------------------------------------------------------------------
// THE STATEMENT. A year small enough to check by hand:
//   opening   Bank 10,00,000 Dr   Capital 10,00,000 Cr
//   a sale of 2,00,000 on credit; 1,50,000 of it collected; rent 30,000 paid by bank
// ---------------------------------------------------------------------------
{
  const snapshot = {
    from: '20250401', to: '20260331', company: 'CDC PRINTERS 2025-26',
    opening: { 'HDFC Bank': -1000000, 'Capital': 1000000 },
    closing: { 'HDFC Bank': -1120000, 'Capital': 1000000, 'Customer A': -50000, 'Sale - Printing': 200000, 'Rent': -30000 },
    ledgers: { 'HDFC Bank': 'Bank Accounts', 'Capital': 'Capital Account', 'Customer A': 'Sundry Debtors',
      'Sale - Printing': 'Sales Accounts', 'Rent': 'Indirect Expenses' },
    groups: { 'Bank Accounts': 'Current Assets', 'Sundry Debtors': 'Current Assets', 'Current Assets': null,
      'Capital Account': null, 'Sales Accounts': null, 'Indirect Expenses': null },
  };
  // Postings for the whole year (the check) and up to 30 Sep (the date asked for):
  // by 30 Sep the sale and the rent are booked, the collection is not.
  const moves = [
    { ledger: 'Customer A', dr: -200000, cr: 0, drCheck: -200000, crCheck: 150000 },
    { ledger: 'Sale - Printing', dr: 0, cr: 200000, drCheck: 0, crCheck: 200000 },
    { ledger: 'Rent', dr: -30000, cr: 0, drCheck: -30000, crCheck: 0 },
    { ledger: 'HDFC Bank', dr: 0, cr: 30000, drCheck: -150000, crCheck: 30000 },
  ];
  const tb = T.buildTrialBalance({ snapshot, moves, date: '20250930' });
  const row = (n) => tb.rows.find((r) => r.ledger === n);

  assert(near(row('HDFC Bank').closing, -970000), 'the bank stands 9,70,000 Dr on 30 Sep: opened 10,00,000, paid 30,000 rent');
  assert(near(row('Customer A').closing, -200000), 'the customer owes the whole 2,00,000 on 30 Sep, the collection being later');
  assert(near(row('Rent').debit, 30000) && near(row('Rent').credit, 0), 'a debit reads in the Debit column as a positive figure');
  assert(near(tb.totals.closingDebit, tb.totals.closingCredit),
    'the trial balance BALANCES: every debit has its credit');
  assert(near(tb.closingDifference, 0) && near(tb.openingDifference, 0), 'and so did the openings Tally gave');
  assert(row('Customer A').chain.join(' > ') === 'Current Assets > Sundry Debtors', 'each ledger sits under its groups, root first');
  const ca = tb.groups.find((g) => g.path === 'Current Assets');
  assert(ca && near(ca.closing, -1170000), 'a group carries the total of everything beneath it: bank 9,70,000 + debtor 2,00,000');

  // THE CHECK: opening + every posting held, at the day Tally's closing stands on.
  assert(tb.check && tb.check.asOn === '20260331', 'the comparison is made on the day Tally\'s own closing stands, whatever date was asked for');
  assert(tb.check.mismatched === 0 && tb.check.compared === 5,
    'opening + every posting lands on Tally\'s closing for all five ledgers: the capture for the year is COMPLETE');

  // A MISSING VOUCHER shows up as the ledgers it touched, by name.
  const short = moves.map((m) => (m.ledger === 'Rent' ? { ...m, drCheck: 0 } : m.ledger === 'HDFC Bank' ? { ...m, crCheck: 0 } : m));
  const bad = T.buildTrialBalance({ snapshot, moves: short, date: '20250930' });
  assert(bad.check.mismatched === 2, 'a voucher we do not hold breaks the comparison for exactly the two ledgers it posted to');
  assert(bad.check.mismatches.some((m) => m.ledger === 'Rent' && near(m.diff, 30000)),
    'and names them, with the amount each is out by');

  // A LEDGER WE HAVE NEVER SEEN but Tally closes with a balance is the clearest gap of all.
  const snap2 = { ...snapshot, closing: { ...snapshot.closing, 'Unknown Loan': 500000 } };
  const gap = T.buildTrialBalance({ snapshot: snap2, moves, date: '20250930' });
  assert(gap.check.mismatches.some((m) => m.ledger === 'Unknown Loan' && near(m.tally, 500000) && near(m.ours, 0)),
    'a ledger Tally closes at 5,00,000 that no voucher of ours touches is reported, not skipped for want of a row');
  assert(!gap.rows.some((r) => r.ledger === 'Unknown Loan'), 'while staying out of the statement itself, where it has no figure');
}

// ---------------------------------------------------------------------------
// OPENINGS THAT DO NOT BALANCE are Tally's "Difference in opening balances", shown as such.
// ---------------------------------------------------------------------------
{
  const tb = T.buildTrialBalance({ date: '20190930', moves: [],
    snapshot: { from: '20190401', to: '20200331', opening: { Bank: -500, Capital: 400 }, closing: { Bank: -500, Capital: 400 }, ledgers: {}, groups: {} } });
  assert(near(tb.openingDifference, -100), 'openings that do not balance among themselves are reported as a difference of 100, not hidden in a total');
  assert(tb.unclassified === 2, 'and ledgers outside this year\'s chart of accounts are counted');
  const pl = T.buildTrialBalance({ date: '20190930', moves: [],
    snapshot: { from: '20190401', to: '20200331', opening: { 'Profit & Loss A/c': 700, Bank: -700 }, closing: {},
      ledgers: { 'Profit & Loss A/c': '', Bank: 'Bank Accounts' }, groups: { 'Bank Accounts': null } } });
  assert(pl.rows.find((r) => r.ledger === 'Profit & Loss A/c').chain.join() === 'Primary' && pl.unclassified === 0,
    'Profit & Loss A/c, which Tally files under no group, sits under Primary and is NOT counted as missing from the chart');
}

// ---------------------------------------------------------------------------
// WHAT INGEST WILL AND WILL NOT STORE.
// ---------------------------------------------------------------------------
{
  const ok = cleanSnapshots({ snapshots: [{ from: '20190401', to: '20200331', company: 'CDC PRINTERS 2019-20',
    opening: { Bank: '-500.004', Zero: 0, Capital: 500 }, closing: { Bank: -700 } }] });
  assert(ok.length === 1 && ok[0].opening.Bank === -500 && !('Zero' in ok[0].opening),
    'a snapshot is stored with its amounts as numbers, and nil balances left out');
  assert(cleanSnapshots({ snapshots: { from: '20190401', to: '20200331', opening: { A: 1 }, closing: {} } }).length === 1,
    'a single snapshot that PowerShell unwrapped from its array is still read');
  assert(cleanSnapshots({ snapshots: [{ from: '20190401', to: '20200331', opening: {}, closing: {} }] }).length === 0,
    'an EMPTY snapshot is the shape of a failed pull and is not stored -- it would read as every ledger at nil');
  assert(cleanSnapshots({ snapshots: [{ from: '2019-04-01', to: '20200331', opening: { A: 1 } }] }).length === 0,
    'nor is one whose dates are not dates');
  assert(cleanSnapshots({}).length === 0, 'a master with no snapshots stores none');
}

console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== trial balance arithmetic passed ==');
process.exit(fails ? 1 : 0);
