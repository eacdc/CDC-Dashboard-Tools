'use strict';
// The funds-flow arithmetic, driven directly: no database, no network. Every claim here
// is a claim about the business, not about the code.
const F = require('./fundsFlow');

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  - ' + msg);
  else { console.log('FAIL: ' + msg); fails++; }
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// A balance is Tally's opening plus the postings since -- in BOTH directions.
// ---------------------------------------------------------------------------
{
  const post = [{ date: '20260410', amt: 100 }, { date: '20260510', amt: 200 }, { date: '20260610', amt: 400 }];
  assert(F.balanceAsAt(1000, '20260401', '20260531', post) === 1300,
    'a balance is the opening plus every posting up to the day asked for');
  // The opening can stand AFTER the date asked for, and then the postings in between are
  // already inside it and have to come back off.
  assert(F.balanceAsAt(1700, '20260701', '20260531', post) === 1300,
    'an opening that stands LATER than the date asked for has the postings between them taken back off');
  assert(F.balanceAsAt(0, null, '20260531', post) === 300,
    'with no opening from Tally the figure is movement only, never presented as a balance');
}

// ---------------------------------------------------------------------------
// The opening position stands at the close of the day BEFORE the window opens.
// ---------------------------------------------------------------------------
{
  assert(F.dayBefore('20260401') === '20260331', 'the window opening stands on the day before it starts');
  assert(F.dayBefore('20260301') === '20260228', 'the day before 1 March 2026 is 28 February, not 29');
  assert(F.dayBefore('20240301') === '20240229', 'and in a leap year it is 29 February');
  assert(F.dayBefore('20270101') === '20261231', 'a new year rolls back to 31 December');
}

// ---------------------------------------------------------------------------
// Tally's raw sign is turned exactly once: a receivable reads POSITIVE.
// ---------------------------------------------------------------------------
{
  const openings = { kol: { asOn: '20260401', debtor: -5000000, creditor: 3000000 } };
  const pos = F.tradePosition(openings, [], '20260401');
  assert(pos.receivables === 5000000, 'a debtor balance (Tally Dr, -ve) is reported as a POSITIVE receivable');
  assert(pos.payables === 3000000, 'a creditor balance (Tally Cr, +ve) is reported as a positive payable');
  assert(pos.net === 2000000, 'the net trade position is what is owed to us less what we owe');
}

// ---------------------------------------------------------------------------
// The whole statement, on a year that is easy to check by hand.
//
//   Trade at 31-Mar:  receivables 5 Cr, payables 3 Cr  -> net 2 Cr tied up
//   Trade at 31-Mar+1yr: receivables 8 Cr, payables 4 Cr -> net 4 Cr
//        so 2 Cr MORE money sat in trade.
//   Machines capitalised 6 Cr, advances out another 1 Cr.
//   Loans went from 10 Cr to 15 Cr: 5 Cr borrowed.
//   Absorbed 2 + 6 + 1 = 9 Cr; borrowed 5 Cr; 4 Cr came from somewhere this
//   statement does not track.
// ---------------------------------------------------------------------------
{
  const CR = 10000000;
  const f = F.buildFundsFlow({
    from: '20260401', to: '20270331',
    openings: { kol: { asOn: '20260401', debtor: -5 * CR, creditor: 3 * CR } },
    // Postings dated inside the window move the closing position only.
    rows: [{ branch: 'kol', date: '20260901', debtor: -3 * CR, creditor: 1 * CR }],
    loans: { opening: 10 * CR, closing: 15 * CR },
    capex: { additions: 6 * CR, advanceNet: 1 * CR },
  });

  assert(near(f.opening.tradeNet, 2 * CR), 'the year opens with 2 Cr of funds sitting in trade');
  assert(near(f.closing.receivables, 8 * CR) && near(f.closing.payables, 4 * CR),
    'a year of postings carries the trade balances forward from Tally\'s own opening');
  assert(near(f.change.tradeNet, 2 * CR), 'trade absorbed another 2 Cr over the year');
  assert(near(f.change.loans, 5 * CR), 'borrowing rose by 5 Cr');
  assert(near(f.uses, 9 * CR), 'trade, machines and advances absorbed 9 Cr between them');
  assert(near(f.sources, 5 * CR), 'new borrowing supplied 5 Cr of it');
  assert(near(f.residual, 4 * CR), 'the remaining 4 Cr came from outside what this statement tracks');
  assert(f.fundedShare === 55.6, 'and borrowing covered 55.6% of what was absorbed');

  const borrow = f.lines.find((l) => l.label === 'Borrowing');
  assert(borrow && borrow.side === 'source', 'money borrowed is a SOURCE of funds');
  const trade = f.lines.find((l) => l.label === 'Money tied up in trade');
  assert(trade && trade.side === 'use', 'money moving into trade is a USE of funds');
}

// ---------------------------------------------------------------------------
// THE SIGNS DECIDE THE SIDE. A year of collecting debts and repaying loans is the
// mirror image, and a statement that files each line on a fixed side reports it as
// though nothing happened.
// ---------------------------------------------------------------------------
{
  const CR = 10000000;
  const f = F.buildFundsFlow({
    from: '20260401', to: '20270331',
    openings: { kol: { asOn: '20260401', debtor: -8 * CR, creditor: 2 * CR } },
    rows: [{ branch: 'kol', date: '20260901', debtor: 3 * CR, creditor: 2 * CR }],  // collected 3 Cr, owe 2 Cr more
    loans: { opening: 15 * CR, closing: 11 * CR },                                  // repaid 4 Cr
    capex: { additions: 0, advanceNet: -1 * CR },                                   // an advance turned into a machine
  });
  assert(near(f.change.tradeNet, -5 * CR), 'collecting 3 Cr and owing 2 Cr more releases 5 Cr from trade');
  const trade = f.lines.find((l) => l.label === 'Money tied up in trade');
  assert(trade.side === 'source', 'trade that RELEASES money is a source of funds, not a use');
  const borrow = f.lines.find((l) => l.label === 'Borrowing');
  assert(borrow.side === 'use', 'debt repaid ABSORBS funds and is reported as a use');
  assert(near(f.uses, 4 * CR), 'the 4 Cr of debt repaid is the only use that year');
  assert(near(f.sources, 6 * CR), 'trade released 5 Cr and an advance released 1 Cr');
  assert(near(f.residual, -2 * CR), 'more was released than was spent, and the residual says so rather than hiding it');
  assert(f.fundedByBorrowing === 0, 'a year of repayment funded nothing by borrowing');
}

// ---------------------------------------------------------------------------
// BOTH COMPANIES ADD UP. Each is read from its own opening, as the loan page does.
// ---------------------------------------------------------------------------
{
  const L = 100000;
  const f = F.buildFundsFlow({
    from: '20260401', to: '20270331',
    openings: {
      kol: { asOn: '20260401', debtor: -50 * L, creditor: 20 * L },
      ahm: { asOn: '20260401', debtor: -30 * L, creditor: 10 * L },
    },
    rows: [],
    loans: { opening: 0, closing: 0 }, capex: { additions: 0, advanceNet: 0 },
  });
  assert(near(f.opening.receivables, 80 * L), 'consolidated receivables are both companies added together');
  assert(near(f.opening.payables, 30 * L), 'and so are the payables');
  assert(near(f.uses, 0) && near(f.sources, 0), 'a period in which nothing moved absorbs and supplies nothing');
}

// ---------------------------------------------------------------------------
// A BRANCH WHOSE OPENINGS NEVER ARRIVED gives movement, not a balance -- and the
// arithmetic must still be internally consistent, so the page can say which it is.
// ---------------------------------------------------------------------------
{
  const L = 100000;
  const f = F.buildFundsFlow({
    from: '20260401', to: '20270331',
    openings: { kol: { asOn: null, debtor: 0, creditor: 0 } },
    rows: [{ branch: 'kol', date: '20260901', debtor: -10 * L, creditor: 4 * L }],
    loans: { opening: 0, closing: 0 }, capex: { additions: 0, advanceNet: 0 },
  });
  assert(near(f.opening.tradeNet, 0), 'with no opening the window starts from nothing');
  assert(near(f.change.tradeNet, 6 * L), 'and the CHANGE over the window is still right, which is what the statement reports');
}

// ---------------------------------------------------------------------------
// The window is checked, since a reversed one would read as a negative year.
// ---------------------------------------------------------------------------
{
  let threw = null;
  try { F.buildFundsFlow({ from: '20270331', to: '20260401', openings: {}, rows: [] }); }
  catch (e) { threw = e.message; }
  assert(threw && threw.indexOf('before') >= 0, 'a window that ends before it starts is refused by name');
}

console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== funds-flow arithmetic passed ==');
process.exit(fails ? 1 : 0);
