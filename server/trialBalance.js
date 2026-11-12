'use strict';
// THE TRIAL BALANCE AS ON ANY DATE -- and the proof that what we hold is what Tally holds.
//
// A trial balance is the one report that touches every ledger and every voucher at once:
//
//     closing balance of a ledger as on D  =  its opening balance for the period
//                                           +  every posting to it from the period's
//                                              first day up to D
//
// So it needs three things, and until now the database held one and a half of them:
//
//   1. EVERY POSTING. Held: each voucher carries every ledger leg, both maps.
//   2. THE OPENING OF EVERY LEDGER, FOR EVERY PERIOD. Held for ONE period only -- the live
//      company's -- because `masters` is one document per branch and a back-fill of an old
//      year was forbidden to write its balances there (they would have replaced the current
//      ones). CDC keeps one Tally company per financial year, and a revenue ledger starts
//      every year at nil, so no amount of walking vouchers backwards can recover an old
//      year's opening. That is what the `balances` collection is: one snapshot per branch
//      per period, each with its own opening, its own closing, and the chart of accounts
//      AS IT STOOD THAT YEAR.
//   3. WHICH VOUCHERS POST AT ALL. A Sales Order carries ledger amounts and posts nothing.
//      Tally decides that by the voucher type's BASE type, and a type can be renamed to
//      anything ("Purchase - Fixed Assets"), so the names alone cannot say. That is the
//      voucher-type master, `vtypes`: name -> parent, walked to the reserved root.
//
// And then the half that makes it worth trusting: every snapshot also holds TALLY'S OWN
// CLOSING for its period. Opening + every posting we hold must land on it, ledger by
// ledger. Where it does, the capture for that period is complete -- not believed complete,
// shown complete. Where it does not, the ledgers that differ are named.
//
// SIGNS ARE TALLY'S, kept raw end to end: -ve = Dr, +ve = Cr. They are turned into Debit
// and Credit columns at the edge and nowhere else, and nothing here takes an absolute
// value of a figure that could net.

const DATE8 = /^\d{8}$/;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Tally's reserved voucher types that post NOTHING to the books of account. Orders and
// stock movements carry amounts in the XML -- an order's are what it WOULD post, a
// delivery note's are stock values -- and a memorandum or a reversing journal is by
// definition outside the books. Matched EXACTLY against the reserved base name once the
// chain has been walked. Note what is NOT here: Payroll posts (it debits salaries and
// credits what is payable), so it is an accounting voucher however the receivables code
// treats it for its own purposes.
const NON_ACCOUNTING_BASE = [
  'Memorandum', 'Reversing Journal',
  'Sales Order', 'Purchase Order', 'Job Work In Order', 'Job Work Out Order',
  'Delivery Note', 'Receipt Note', 'Rejections In', 'Rejections Out',
  'Stock Journal', 'Physical Stock', 'Material In', 'Material Out',
  'Attendance',
];
const NON_ACCOUNTING_SET = new Set(NON_ACCOUNTING_BASE.map((x) => x.toLowerCase()));

// Walk a voucher type up to the reserved type it was created from. A reserved type's own
// parent comes back from Tally either empty or as itself, so both end the walk; a parent
// the master does not hold ends it too (the name reached is the best answer available).
function baseType(name, vtypes) {
  let cur = String(name || '');
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const par = vtypes ? vtypes[cur] : undefined;
    if (par == null || par === '' || par === cur) break;
    cur = String(par);
  }
  return cur;
}

// Does a voucher of this type post to the books? `how` says what the answer rests on,
// because a type classified from Tally's own master and one guessed from its name are not
// the same quality of fact and the page must be able to say which it had.
function postsToBooks(type, vtypes) {
  const t = String(type || '');
  if (vtypes && Object.prototype.hasOwnProperty.call(vtypes, t)) {
    const base = baseType(t, vtypes);
    return { posts: !NON_ACCOUNTING_SET.has(base.toLowerCase()), base, how: 'master' };
  }
  // No master for this name: a type deleted or renamed since, or a year whose master was
  // never pulled. Fall back to the name itself, by prefix, the way the receivables code
  // has always had to -- and say so.
  const lc = t.toLowerCase();
  for (const b of NON_ACCOUNTING_BASE) {
    if (lc.indexOf(b.toLowerCase()) === 0) return { posts: false, base: b, how: 'name' };
  }
  return { posts: true, base: t, how: 'name' };
}

// The last day of the financial year a period starts in (April to March).
function fyEndOf(from) {
  const y = +from.slice(0, 4), m = +from.slice(4, 6);
  const endYear = m >= 4 ? y + 1 : y;
  return `${endYear}0331`;
}
function fyLabel(from) {
  const y = +from.slice(0, 4), m = +from.slice(4, 6);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}

// Which stored period answers for this date: the latest one that starts on or before it,
// provided the date still falls inside that period's financial year. A date past the end
// of the newest snapshot's year, or before the oldest one, has NO answer -- and gets
// none, rather than the nearest period's opening pressed into service.
function pickSnapshot(snapshots, date) {
  let best = null;
  for (const s of snapshots || []) {
    if (!s || !DATE8.test(String(s.from || ''))) continue;
    if (s.from > date) continue;
    if (!best || s.from > best.from) best = s;
  }
  if (!best) return null;
  if (date > fyEndOf(best.from)) return null;
  return best;
}

// The group chain of a ledger, root first, from ONE year's own chart of accounts.
function chainOf(ledger, ledgers, groups) {
  const out = [];
  let cur = ledgers ? ledgers[ledger] : null;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(cur);
    cur = groups ? groups[cur] : null;
  }
  return out;
}

// input:
//   snapshot  { from, to, opening{}, closing{}, ledgers{}, groups{} }   Tally-raw
//   moves     [ { ledger, dr, cr, drCheck, crCheck } ]
//             dr/cr           postings from snapshot.from up to `date`        (dr <= 0, cr >= 0)
//             drCheck/crCheck postings from snapshot.from up to snapshot.to   (same signs)
//   date      the day the trial balance stands on
function buildTrialBalance({ snapshot, moves, date, chart }) {
  if (!snapshot) throw new Error('a balance snapshot is required');
  if (!DATE8.test(String(date || ''))) throw new Error('date is required as YYYYMMDD');
  const opening = snapshot.opening || {};
  const tallyClosing = snapshot.closing || {};
  const ledgersMap = (chart && chart.ledgers) || snapshot.ledgers || {};
  const groupsMap = (chart && chart.groups) || snapshot.groups || {};

  const byLedger = new Map();
  const row = (name) => {
    let r = byLedger.get(name);
    if (!r) { r = { ledger: name, opening: 0, dr: 0, cr: 0, drCheck: 0, crCheck: 0 }; byLedger.set(name, r); }
    return r;
  };
  for (const k of Object.keys(opening)) row(k).opening = Number(opening[k]) || 0;
  for (const m of moves || []) {
    const r = row(String(m.ledger));
    r.dr += Number(m.dr) || 0; r.cr += Number(m.cr) || 0;
    r.drCheck += Number(m.drCheck) || 0; r.crCheck += Number(m.crCheck) || 0;
  }
  // A ledger Tally closes with a balance but which neither opened with one nor moved in
  // anything we hold still belongs in the comparison -- it is exactly the ledger whose
  // vouchers are missing.
  for (const k of Object.keys(tallyClosing)) row(k);

  const rows = [];
  let totOpen = 0, totDr = 0, totCr = 0, totClose = 0, closeDr = 0, closeCr = 0;
  const mismatches = [];
  let compared = 0, unclassified = 0;
  const canCheck = !!(snapshot.closing && DATE8.test(String(snapshot.to || '')));
  for (const r of byLedger.values()) {
    const closing = r2(r.opening + r.dr + r.cr);
    let chain = chainOf(r.ledger, ledgersMap, groupsMap);
    // A ledger the chart HOLDS but files under no group is one of Tally's own, sitting
    // directly under Primary -- "Profit & Loss A/c" is the one every company has. That is
    // a different thing from a ledger the chart does not hold at all, and only the second
    // is a gap worth counting.
    if (!chain.length && Object.prototype.hasOwnProperty.call(ledgersMap, r.ledger)) chain = ['Primary'];
    if (!chain.length) unclassified++;
    if (canCheck) {
      const ours = r2(r.opening + r.drCheck + r.crCheck);
      const theirs = r2(tallyClosing[r.ledger] || 0);
      compared++;
      if (Math.abs(ours - theirs) > 0.5) {
        mismatches.push({ ledger: r.ledger, group: chain.join(' > '), ours, tally: theirs, diff: r2(ours - theirs) });
      }
    }
    // A ledger with nothing in any column is not part of a trial balance.
    if (Math.abs(r.opening) < 0.005 && Math.abs(r.dr) < 0.005 && Math.abs(r.cr) < 0.005) continue;
    rows.push({ ledger: r.ledger, chain, opening: r2(r.opening), debit: r2(-r.dr), credit: r2(r.cr), closing });
    totOpen += r.opening; totDr += -r.dr; totCr += r.cr; totClose += closing;
    if (closing < 0) closeDr += -closing; else closeCr += closing;
  }
  rows.sort((a, b) => (a.chain.join('>') + '>' + a.ledger).localeCompare(b.chain.join('>') + '>' + b.ledger));
  mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Group totals, every level, so the page can fold the statement the way Tally does.
  const groupTotals = {};
  for (const r of rows) {
    for (let i = 0; i < r.chain.length; i++) {
      const key = r.chain.slice(0, i + 1).join(' > ');
      const g = groupTotals[key] || (groupTotals[key] = { group: r.chain[i], path: key, depth: i, opening: 0, debit: 0, credit: 0, closing: 0, ledgers: 0 });
      g.opening += r.opening; g.debit += r.debit; g.credit += r.credit; g.closing += r.closing; g.ledgers++;
    }
  }
  const groups = Object.values(groupTotals).map((g) => ({ ...g,
    opening: r2(g.opening), debit: r2(g.debit), credit: r2(g.credit), closing: r2(g.closing) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    date, from: snapshot.from, snapshotTo: snapshot.to || null, fy: fyLabel(snapshot.from),
    company: snapshot.company || null,
    rows, groups,
    totals: {
      opening: r2(totOpen), debit: r2(totDr), credit: r2(totCr), closing: r2(totClose),
      closingDebit: r2(closeDr), closingCredit: r2(closeCr),
    },
    // BOTH MUST BE NIL. Tally's own openings for the period must balance among themselves
    // (if they do not, Tally shows the same figure as "Difference in opening balances"),
    // and so must every voucher. A closing difference that is NOT the opening difference
    // means a voucher we hold does not balance, which is a capture fault of ours.
    openingDifference: r2(totOpen),
    closingDifference: r2(totClose),
    check: canCheck ? {
      asOn: snapshot.to, compared, matched: compared - mismatches.length,
      mismatched: mismatches.length, mismatches: mismatches.slice(0, 200),
      mismatchTotal: r2(mismatches.reduce((s, m) => s + Math.abs(m.diff), 0)),
    } : null,
    unclassified,
  };
}

module.exports = { buildTrialBalance, pickSnapshot, postsToBooks, baseType, chainOf, fyEndOf, fyLabel, NON_ACCOUNTING_BASE };
