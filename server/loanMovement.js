// loanMovement.js -- opening, drawdowns, repayments and closing for every borrowing
// account, bucketed by day, week or month.
//
// WHY A PURE MODULE. The arithmetic is the whole report: an opening carried forward, two
// columns of movement, and a closing that has to be the next period's opening or the
// statement is worthless. None of that needs a database, so none of it lives behind one
// -- `/api/loans` is a thin adapter that fetches rows and hands them here, and
// test_loans_fake.js drives this directly.
//
// SIGN CONVENTION. Tally raw: -ve = Dr, +ve = Cr. A loan is a LIABILITY, so money
// borrowed is Cr (+ve) and money repaid is Dr (-ve). Everything this module returns is
// Cr-POSITIVE: a loan outstanding is a positive number, `drawn` adds to it, `repaid`
// subtracts. That is the opposite of the Dr-positive scale the receivables code uses,
// deliberately -- a report nobody can read without a sign convention in their head is a
// report that gets misread, and "loan outstanding: -1,62,00,000" is exactly that.
'use strict';

// ---------------------------------------------------------------------------
// Which ledgers are borrowings
// ---------------------------------------------------------------------------
// By GROUP first, because that is what Tally itself decides. "Bank OD A/c" and
// "Bank OCC A/c" are reserved groups under Loans (Liability) and are where a packing
// credit, cash credit or overdraft normally sits -- those ARE borrowings, and their daily
// churn is the point of this report rather than noise.
// ORDER MATTERS, and not for a reason anyone guesses: "unsecured loans" CONTAINS
// "secured loans", so a substring test in the other order labels every director's loan
// as secured debt. Tested by name in test_loans_fake.js; do not sort this list.
const GROUP_KINDS = [
  { kw: 'bank od', kind: 'od_cc' },
  { kw: 'bank occ', kind: 'od_cc' },
  { kw: 'unsecured loans', kind: 'unsecured' },
  { kw: 'secured loans', kind: 'secured' },
  { kw: 'loans (liability)', kind: 'other' },
];
// By NAME, for an instrument somebody filed straight under Current Liabilities instead
// of a loan group. These words name a facility and never a trading account. They are
// read from the LEDGER NAME, which the group chain never contains -- the mistake that
// hid every PCFC account from the cashflow tab for a year.
const NAME_KINDS = [
  { kw: 'packing credit', kind: 'od_cc' },
  { kw: 'cash credit', kind: 'od_cc' },
  { kw: 'overdraft', kind: 'od_cc' },
  { kw: 'bill discount', kind: 'od_cc' },
  { kw: 'pcfc', kind: 'od_cc' },
  { kw: 'pcre', kind: 'od_cc' },
  { kw: 'wcdl', kind: 'other' },
  { kw: 'term loan', kind: 'secured' },
  { kw: 'buyers credit', kind: 'other' },
  { kw: "buyer's credit", kind: 'other' },
];
// Never a borrowing, whatever it is called. "Loans & Advances (Asset)" is money WE lent
// out and would otherwise be swept in by the word "loan"; a bank or cash account is the
// other side of a repayment, not the loan.
const NOT_BORROWING = ['loans & advances', 'loans and advances', 'current assets',
  'fixed assets', 'investments', 'bank accounts', 'cash-in-hand', 'cash in hand',
  'sundry debtors', 'sundry creditors', 'duties & taxes', 'branch / divisions'];

const KIND_LABELS = { secured: 'Secured loans', unsecured: 'Unsecured loans',
  od_cc: 'OD / CC / packing credit', other: 'Other borrowings' };

// Returns the kind of borrowing this ledger is, or null if it is not one.
// `chain` is the group chain, top group first, as getChain gives it.
function loanKind(name, chain) {
  const cs = (Array.isArray(chain) ? chain.join('>') : String(chain || '')).toLowerCase();
  for (const bad of NOT_BORROWING) if (cs.indexOf(bad) >= 0) return null;
  for (const g of GROUP_KINDS) if (cs.indexOf(g.kw) >= 0) return g.kind;
  // A name match is allowed only where the ledger is at least a liability: the words
  // below are specific, but "Term Loan Interest" under Indirect Expenses is an expense,
  // not a borrowing, and this report must not turn one into the other.
  if (cs.indexOf('current liabilities') >= 0 || cs.indexOf('liabilit') >= 0) {
    const nm = String(name || '').toLowerCase();
    for (const n of NAME_KINDS) if (nm.indexOf(n.kw) >= 0) return n.kind;
  }
  return null;
}

// A ledger whose NAME says borrowing but whose group says otherwise. Not counted -- but
// named in the response, because a loan silently missing from a loan report is the one
// failure nobody would notice.
function nearMiss(name, chain) {
  if (loanKind(name, chain)) return false;
  const nm = String(name || '').toLowerCase();
  return NAME_KINDS.some((n) => nm.indexOf(n.kw) >= 0);
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------
function ymd(d) {
  return String(d.getUTCFullYear())
    + String(d.getUTCMonth() + 1).padStart(2, '0')
    + String(d.getUTCDate()).padStart(2, '0');
}
function asDate(s) {
  const t = String(s);
  return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)));
}
// The Monday of this date's week. Weeks run Monday to Sunday because a bank week does;
// labelling a week by its Monday also keeps the keys sortable as plain dates.
function weekStart(dateStr) {
  const d = asDate(dateStr);
  const dow = d.getUTCDay();            // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return ymd(d);
}
function bucketKeyOf(dateStr, bucket) {
  const s = String(dateStr);
  if (bucket === 'month') return s.slice(0, 6);
  if (bucket === 'week') return weekStart(s);
  return s;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function bucketLabel(key, bucket) {
  const k = String(key);
  if (bucket === 'month') return MON[+k.slice(4, 6) - 1] + ' ' + k.slice(0, 4);
  const d = k.slice(6, 8) + ' ' + MON[+k.slice(4, 6) - 1] + ' ' + k.slice(0, 4);
  return bucket === 'week' ? ('Week of ' + d) : d;
}
// Every bucket between from and to, including ones with no movement at all. A statement
// that skips a quiet week reads as if the loan did not exist that week, and the closing
// balance it carries is exactly what somebody wants to see on a quiet week.
function bucketsBetween(from, to, bucket) {
  const keys = [];
  let cur = asDate(from);
  const end = asDate(to);
  let guard = 0;
  while (cur <= end && guard++ < 20000) {
    keys.push(bucketKeyOf(ymd(cur), bucket));
    if (bucket === 'month') cur.setUTCMonth(cur.getUTCMonth() + 1);
    else if (bucket === 'week') cur.setUTCDate(cur.getUTCDate() + 7);
    else cur.setUTCDate(cur.getUTCDate() + 1);
  }
  // Month and week keys can repeat at the edges (a window starting mid-month).
  return [...new Set(keys)];
}

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
// ledgerMeta : { name: { kind, group, branches:[..] } }  -- the borrowings to report on
// openings   : { branch: { asOn: 'YYYYMMDD'|null, amounts: { ledger: crPositive } } }
// rows       : [{ ledger, branch, date, drawn, repaid }]  both >= 0, Cr-positive sense
// Rows are expected to span [min(asOn, from) .. to]; anything outside is ignored here.
function buildLoanMovement(opts) {
  const { ledgerMeta, openings, rows, from, to, bucket } = opts;
  const keys = bucketsBetween(from, to, bucket);
  const keyIdx = new Map(keys.map((k, i) => [k, i]));

  const names = Object.keys(ledgerMeta);
  // opening[ledger] accumulates the balance as it stood the instant before `from`.
  const opening = {};
  for (const n of names) opening[n] = 0;

  // Tally's own opening balance, where the branch has one and it stands on or before
  // the window start. Openings are per branch, so a loan held in both is the sum.
  const openingAsOn = {};
  const openingKnown = {};
  for (const br of Object.keys(openings || {})) {
    const o = openings[br] || {};
    openingAsOn[br] = o.asOn || null;
    openingKnown[br] = !!o.asOn;
    if (!o.asOn) continue;
    for (const n of names) {
      const amt = (o.amounts || {})[n];
      if (amt) opening[n] = r2(opening[n] + amt);
    }
  }

  // Then every posting between the opening's own day and the window start is folded in,
  // forward when the opening stands before `from` and BACKWARD when it stands after --
  // an opening dated later than the window already contains those postings, so they have
  // to come off rather than be added again.
  const cells = {};                       // ledger -> bucketKey -> {drawn, repaid}
  for (const n of names) cells[n] = {};
  let ignored = 0;
  for (const row of (rows || [])) {
    const n = row.ledger;
    if (!ledgerMeta[n]) { ignored++; continue; }
    const d = String(row.date || '');
    const net = (row.drawn || 0) - (row.repaid || 0);
    if (d < from) {
      const asOn = openingAsOn[row.branch] || null;
      // No opening for this branch: everything before the window simply IS the opening.
      if (!asOn) { opening[n] = r2(opening[n] + net); continue; }
      if (d >= asOn) opening[n] = r2(opening[n] + net);          // after the opening day
      // d < asOn: already inside Tally's opening figure -- adding it would double it.
      continue;
    }
    if (d > to) { ignored++; continue; }
    const asOn = openingAsOn[row.branch] || null;
    if (asOn && d < asOn) {
      // The window starts before the opening stands, so this posting is already inside
      // the opening figure: take it back off, and it then shows as movement in its own
      // bucket, where it belongs.
      opening[n] = r2(opening[n] - net);
    }
    const k = bucketKeyOf(d, bucket);
    if (!keyIdx.has(k)) { ignored++; continue; }
    const c = cells[n][k] || (cells[n][k] = { drawn: 0, repaid: 0 });
    c.drawn = r2(c.drawn + (row.drawn || 0));
    c.repaid = r2(c.repaid + (row.repaid || 0));
  }

  // Per ledger: the running statement, and its totals for the window.
  const loans = [];
  for (const n of names) {
    let run = opening[n];
    const periods = [];
    let tin = 0, tout = 0;
    for (const k of keys) {
      const c = cells[n][k] || { drawn: 0, repaid: 0 };
      const o = run;
      run = r2(o + c.drawn - c.repaid);
      tin = r2(tin + c.drawn); tout = r2(tout + c.repaid);
      periods.push({ key: k, label: bucketLabel(k, bucket), opening: r2(o),
        drawn: c.drawn, repaid: c.repaid, closing: run });
    }
    const meta = ledgerMeta[n];
    loans.push({ ledger: n, kind: meta.kind, kindLabel: KIND_LABELS[meta.kind] || meta.kind,
      group: meta.group || '', branches: meta.branches || [],
      opening: r2(opening[n]), drawn: tin, repaid: tout, closing: run,
      moved: !!(tin || tout), periods });
  }
  // Biggest closing first, and a loan with no movement and no balance last -- a page
  // opening on thirty dormant accounts buries the three that matter.
  loans.sort((a, b) => (Math.abs(b.closing) - Math.abs(a.closing))
    || (Math.abs(b.drawn + b.repaid) - Math.abs(a.drawn + a.repaid))
    || a.ledger.localeCompare(b.ledger));

  // All borrowings together, same statement shape. Summed from the per-ledger cells, so
  // the total cannot disagree with the rows above it.
  let runAll = loans.reduce((s, l) => r2(s + l.opening), 0);
  const openAll = runAll;
  const periods = keys.map((k, i) => {
    let din = 0, dout = 0;
    for (const l of loans) { din = r2(din + l.periods[i].drawn); dout = r2(dout + l.periods[i].repaid); }
    const o = runAll;
    runAll = r2(o + din - dout);
    return { key: k, label: bucketLabel(k, bucket), opening: r2(o), drawn: din, repaid: dout, closing: runAll };
  });

  const byKind = {};
  for (const l of loans) {
    const e = byKind[l.kind] || (byKind[l.kind] = { kind: l.kind, kindLabel: l.kindLabel,
      count: 0, opening: 0, drawn: 0, repaid: 0, closing: 0 });
    e.count++;
    e.opening = r2(e.opening + l.opening); e.drawn = r2(e.drawn + l.drawn);
    e.repaid = r2(e.repaid + l.repaid); e.closing = r2(e.closing + l.closing);
  }

  const total = {
    opening: openAll,
    drawn: loans.reduce((s, l) => r2(s + l.drawn), 0),
    repaid: loans.reduce((s, l) => r2(s + l.repaid), 0),
    closing: runAll,
  };
  return { bucket, from, to, buckets: keys.length, loans, periods,
    byKind: Object.values(byKind).sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing)),
    total, openingAsOn, openingKnown, ignoredRows: ignored };
}

module.exports = { loanKind, nearMiss, bucketKeyOf, bucketLabel, bucketsBetween,
  weekStart, buildLoanMovement, KIND_LABELS, GROUP_KINDS, NAME_KINDS, NOT_BORROWING };
