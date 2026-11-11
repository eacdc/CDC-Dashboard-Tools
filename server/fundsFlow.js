'use strict';
// WHERE THE MONEY WENT, AND HOW MUCH OF IT WAS BORROWED.
//
// Three balances the company can be read off Tally's own accounts -- what customers owe
// us, what we owe suppliers, and what we owe banks -- plus what was spent on machines.
// Between two dates, the CHANGE in each says where funds were absorbed and where they
// came from, and the two sides are then set against each other: of everything that went
// into trade and machinery this period, this much arrived as new borrowing.
//
// WHAT THIS DELIBERATELY DOES NOT DO.
//
// It does not claim to be a complete funds-flow statement, because it cannot be. STOCK IS
// LEFT OUT ENTIRELY -- the inventory in Tally is not maintained closely enough to put a
// figure on, and a working-capital statement carrying a stock number nobody trusts is
// worse than one that says it has none. Cash and bank balances, taxes, and everything
// else on the balance sheet are out too. So the difference between what was absorbed and
// what was borrowed is a BALANCING FIGURE: it is what the tracked uses cost beyond the
// borrowing, and it is NOT a measured figure for anything. Reporting it as profit would be
// a claim this file has no way to support, and `residual` is named for what it is.
//
// SCALE. Receivables are reported Dr-positive (money owed TO us is a positive number) and
// payables and loans Cr-positive (money we owe is a positive number), because "payables:
// -4,10,00,000" is a figure that gets misread -- the same reasoning as the loan page.
// Tally's own raw sign is the opposite for debtors, so a debtor total arrives -ve and is
// turned once, here, at the edge.

const DATE8 = /^\d{8}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A balance as at the END of `on`, built the way the loan page builds one: Tally's own
// opening on the day it stands, plus every posting from that day to this one -- and MINUS
// any posting after this day but before the opening's own day, which the opening already
// contains. Both directions matter: the opening can stand before OR after the date asked
// for, and getting the second case wrong counts a period twice.
function balanceAsAt(tallyOpen, asOn, on, postings) {
  let bal = Number(tallyOpen) || 0;
  for (const p of postings) {
    const d = String(p.date || '');
    if (!DATE8.test(d)) continue;
    if (asOn && d >= asOn && d <= on) bal += Number(p.amt) || 0;
    else if (asOn && d > on && d < asOn) bal -= Number(p.amt) || 0;
    else if (!asOn && d <= on) bal += Number(p.amt) || 0;   // no opening: movement only
  }
  return bal;
}

// The day before `from`: the opening balances are the position the window STARTS at, so
// they stand at the close of the previous day, not of the first day of the window.
function dayBefore(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

// openings: { br: { asOn, debtor, creditor } }   Tally-raw (debtor -ve, creditor +ve)
// rows:     [ { branch, date, debtor, creditor } ]  Tally-raw sums of that day's postings
function tradePosition(openings, rows, on) {
  let debtor = 0, creditor = 0;
  for (const br of Object.keys(openings || {})) {
    const o = openings[br] || {};
    const mine = (rows || []).filter((r) => r.branch === br);
    debtor += balanceAsAt(o.debtor, o.asOn, on, mine.map((r) => ({ date: r.date, amt: r.debtor })));
    creditor += balanceAsAt(o.creditor, o.asOn, on, mine.map((r) => ({ date: r.date, amt: r.creditor })));
  }
  // Tally-raw -> the scale a reader expects. A debtor's balance is a Dr, so it arrives
  // negative; a creditor's is a Cr and arrives positive.
  const receivables = r2(-debtor);
  const payables = r2(creditor);
  return { receivables, payables, net: r2(receivables - payables) };
}

// `uses` and `sources` are decided by the SIGN of each movement, not by which line it is.
// Trade that released money funds the business as surely as a loan does, and a loan repaid
// absorbs funds as surely as a machine -- a statement that files each line on a fixed side
// reports a year of debt repayment as though nothing happened.
function side(label, amt, useWhenPositive, note) {
  const v = r2(amt);
  if (!v) return null;
  const isUse = v > 0 ? useWhenPositive : !useWhenPositive;
  return { label, amount: Math.abs(v), signed: v, side: isUse ? 'use' : 'source', note };
}

function buildFundsFlow(input) {
  const { from, to } = input;
  if (!DATE8.test(String(from || '')) || !DATE8.test(String(to || ''))) {
    throw new Error('from and to are required as YYYYMMDD');
  }
  if (String(to) < String(from)) throw new Error(`to (${to}) is before from (${from})`);

  const openAt = dayBefore(String(from));
  const tOpen = tradePosition(input.openings, input.rows, openAt);
  const tClose = tradePosition(input.openings, input.rows, String(to));

  const loans = input.loans || { opening: 0, closing: 0 };
  const loanOpen = r2(loans.opening);
  const loanClose = r2(loans.closing);

  const capex = input.capex || { additions: 0, advanceNet: 0 };
  const capitalised = r2(capex.additions);
  const advances = r2(capex.advanceNet);

  const tradeMove = r2(tClose.net - tOpen.net);     // +ve = more money tied up in trade
  const borrowed = r2(loanClose - loanOpen);        // +ve = borrowed more than repaid

  const lines = [
    side('Money tied up in trade', tradeMove, true,
      'Receivables less payables. It rises when customers owe us more, or when we owe suppliers less -- either way the money is in the business rather than in the bank.'),
    side('Machines and buildings capitalised', capitalised, true,
      'What reached the fixed-asset ledgers in this period. Committed, not paid: a machine booked but unpaid is in it.'),
    side('Advances for machines not yet here', advances, true,
      'The change in the capital-advance accounts: money paid against proformas for machines that have not arrived.'),
    side('Borrowing', borrowed, false,
      'Loans, OD and CC, packing credit and the rest, at closing against opening. A positive figure is new borrowing; a negative one is debt repaid, which absorbs funds like any other use.'),
  ].filter(Boolean);

  const uses = r2(lines.filter((l) => l.side === 'use').reduce((s, l) => s + l.amount, 0));
  const sources = r2(lines.filter((l) => l.side === 'source').reduce((s, l) => s + l.amount, 0));

  // THE BALANCING FIGURE, AND IT IS ONLY THAT. Stock is out of this statement by design,
  // and so are cash, bank, taxes and everything else on the balance sheet -- so this is
  // what the tracked uses cost beyond the tracked sources, and nothing more. It is not a
  // measurement of anything and must never be presented as one.
  const residual = r2(uses - sources);

  const borrowedForUses = borrowed > 0 ? borrowed : 0;
  const fundedShare = uses > 0 ? Math.round((borrowedForUses / uses) * 1000) / 10 : null;

  return {
    from, to, openAt,
    scale: 'receivables Dr-positive; payables, loans Cr-positive',
    opening: { receivables: tOpen.receivables, payables: tOpen.payables, tradeNet: tOpen.net, loans: loanOpen },
    closing: { receivables: tClose.receivables, payables: tClose.payables, tradeNet: tClose.net, loans: loanClose },
    change: {
      receivables: r2(tClose.receivables - tOpen.receivables),
      payables: r2(tClose.payables - tOpen.payables),
      tradeNet: tradeMove,
      loans: borrowed,
      capitalised, advances,
    },
    lines, uses, sources, residual,
    fundedByBorrowing: borrowedForUses, fundedShare,
    excludes: 'Stock is not in this statement: the inventory in Tally is not maintained closely enough to put a figure on. Cash and bank balances, taxes and the rest of the balance sheet are out too.',
  };
}

module.exports = { buildFundsFlow, tradePosition, balanceAsAt, dayBefore };
