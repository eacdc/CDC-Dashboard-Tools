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
// EXPORT CREDIT IS ITS OWN KIND, not a flavour of secured debt. Tally files PCFC and
// PCRE under Secured Loans because they are secured -- but a packing credit drawn against
// one shipment and repaid when that shipment is realised answers a different question
// from a seven-year term loan on a printing press, and summing them tells you neither.
// The books already separate them by sub-group ("Secured Loans > PCRE Loan Citi Bank"),
// so the chain usually says so; the ledger NAME is read as well, because getChain never
// includes it and an account filed straight under Secured Loans still says PCFC in its
// name.
//
// Buyer's credit is deliberately NOT here: it finances imports, not exports.
const EXPORT_KW = ['pcfc', 'pcre', 'packing credit', 'bill discount', 'bill discounting',
  'export credit', 'preshipment', 'pre-shipment', 'post shipment', 'post-shipment',
  'export finance', 'export packing'];
// By NAME, for an instrument somebody filed straight under Current Liabilities instead
// of a loan group. These words name a facility and never a trading account. They are
// read from the LEDGER NAME, which the group chain never contains -- the mistake that
// hid every PCFC account from the cashflow tab for a year.
const NAME_KINDS = [
  { kw: 'cash credit', kind: 'od_cc' },
  { kw: 'overdraft', kind: 'od_cc' },
  { kw: 'wcdl', kind: 'other' },
  { kw: 'term loan', kind: 'term' },
  { kw: 'buyers credit', kind: 'other' },
  { kw: "buyer's credit", kind: 'other' },
];
// Never a borrowing, whatever it is called. "Loans & Advances (Asset)" is money WE lent
// out and would otherwise be swept in by the word "loan"; a bank or cash account is the
// other side of a repayment, not the loan.
// `liability for expenses` is the accruals group: "Interest on Term Loan Payable" is
// interest owed, not money borrowed. It was being counted because its NAME says "Term
// Loan" and it sits under Current Liabilities -- nil in the window it was spotted in, so
// it distorted nothing, but it would the moment interest is accrued.
const NOT_BORROWING = ['loans & advances', 'loans and advances', 'current assets',
  'fixed assets', 'investments', 'bank accounts', 'cash-in-hand', 'cash in hand',
  'sundry debtors', 'sundry creditors', 'duties & taxes', 'branch / divisions',
  'liability for expenses', 'provisions'];
// And the same thing said by name, because a company can accrue interest anywhere. These
// only ever BLOCK the name-based path -- a ledger the GROUP says is a loan stays one, so
// "L/C Payable to Muller Martini" under Secured Loans is untouched by the word "payable".
const NOT_BORROWING_NAME = ['interest', 'subvention', 'receivable', 'provision',
  'charges', 'commission', 'penalty'];

const KIND_LABELS = {
  od_cc: 'OD / CC (working capital)',
  export: 'Export credit (PCFC / PCRE / packing credit)',
  term: 'Term loans',
  unsecured: 'Unsecured loans',
  other: 'Other borrowings',
};
// Short-term first, long-term last. A fixed order, because a summary whose sections
// reorder themselves between loads is a summary nobody learns to read.
const KIND_ORDER = ['od_cc', 'export', 'term', 'unsecured', 'other'];

function isExportCredit(hay) {
  for (const k of EXPORT_KW) if (hay.indexOf(k) >= 0) return true;
  return false;
}

// Returns the kind of borrowing this ledger is, or null if it is not one.
// `chain` is the group chain, top group first, as getChain gives it.
//
// The GROUP picks the family, then export credit is split out of it by sub-group or by
// name. An OD/CC account keeps its family whatever it is called: an account that sweeps
// is reported by its balance, and that matters more than which facility it funds.
function loanKind(name, chain) {
  const cs = (Array.isArray(chain) ? chain.join('>') : String(chain || '')).toLowerCase();
  const nm = String(name || '').toLowerCase();
  for (const bad of NOT_BORROWING) if (cs.indexOf(bad) >= 0) return null;
  let family = null;
  for (const g of GROUP_KINDS) if (cs.indexOf(g.kw) >= 0) { family = g.kind; break; }
  if (family === 'od_cc' || family === 'unsecured') return family;
  if (family === 'secured' || family === 'other') {
    return isExportCredit(cs + '>' + nm) ? 'export' : (family === 'secured' ? 'term' : 'other');
  }
  // A name match is allowed only where the ledger is at least a liability: the words
  // below are specific, but "Term Loan Interest" under Indirect Expenses is an expense,
  // not a borrowing, and this report must not turn one into the other.
  if (cs.indexOf('current liabilities') >= 0 || cs.indexOf('liabilit') >= 0) {
    for (const bad of NOT_BORROWING_NAME) if (nm.indexOf(bad) >= 0) return null;
    if (isExportCredit(nm)) return 'export';
    for (const n of NAME_KINDS) if (nm.indexOf(n.kw) >= 0) return n.kind;
  }
  return null;
}

// An OD, CC or packing-credit account SWEEPS: every receipt pays it down and every
// payment draws it up, so its gross in and out are the company's whole turnover passing
// through, not borrowing decisions. On one account over seven months that was 204 Cr
// drawn against 169 Cr repaid -- 223 Cr of the 277 Cr "drawn" headline -- which buried
// the 54 Cr of real new facilities. For these accounts only the CLOSING balance and the
// net change mean anything, so the gross is reported but kept out of the headline.
const SWEEP_KINDS = { od_cc: true };
function isSweep(kind) { return !!SWEEP_KINDS[kind]; }

// A ledger whose NAME says borrowing but whose group says otherwise. Not counted -- but
// named in the response, because a loan silently missing from a loan report is the one
// failure nobody would notice.
function nearMiss(name, chain) {
  if (loanKind(name, chain)) return false;
  const nm = String(name || '').toLowerCase();
  // The export words count here too: a real PCFC account filed outside every loan group
  // is exactly the kind of thing that must be named rather than quietly dropped.
  return isExportCredit(nm) || NAME_KINDS.some((n) => nm.indexOf(n.kw) >= 0);
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
  const { ledgerMeta, openings, closings, rows, from, to, bucket } = opts;
  const keys = bucketsBetween(from, to, bucket);
  const keyIdx = new Map(keys.map((k, i) => [k, i]));

  const names = Object.keys(ledgerMeta);
  // opening[ledger] accumulates the balance as it stood the instant before `from`, and
  // its TWO HALVES are kept apart: `openTally` is the opening balance Tally itself
  // carries on its own day, `openPost` is every posting we then added between that day
  // and the window start.
  //
  // That split is the diagnosis, not decoration. When an opening disagrees with Tally,
  // a wrong `tally` half means the master -- the openings were never pulled, or were
  // pulled for the wrong company. A wrong `postings` half means the vouchers: days
  // missing between the opening's day and the window start. One combined figure cannot
  // say which, and on a SWEEPING OD the postings half is a year of turnover, so a small
  // gap there moves the opening by crores.
  const opening = {}, openTally = {}, openPost = {}, openByBranch = {};
  for (const n of names) { opening[n] = 0; openTally[n] = 0; openPost[n] = 0; }

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
      if (amt) {
        opening[n] = r2(opening[n] + amt); openTally[n] = r2(openTally[n] + amt);
        // WHICH COMPANY'S MASTER the opening came from, kept per branch. Consolidated
        // SUMS the two, which is right when each company carries its own share of a
        // facility and doubles it when both carry the same balance for the same account.
        // Nobody can tell those apart from one combined figure, so both are reported and
        // the page shows them side by side.
        (openByBranch[n] || (openByBranch[n] = {}))[br] = r2((openByBranch[n][br] || 0) + amt);
      }
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
      if (!asOn) { opening[n] = r2(opening[n] + net); openPost[n] = r2(openPost[n] + net); continue; }
      // after the opening day
      if (d >= asOn) { opening[n] = r2(opening[n] + net); openPost[n] = r2(openPost[n] + net); }
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
      openPost[n] = r2(openPost[n] - net);
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
    // Tally's OWN closing balance, where the pipeline has brought one and it stands on
    // the very day this window ends. That makes the page self-checking: our opening plus
    // every posting we hold must land on Tally's figure, per account, with no export to
    // reconcile by hand. A difference is the real diagnosis -- it is vouchers we do not
    // hold, or an opening from the wrong period, and it is stated rather than waited for.
    const cl = (closings || {})[meta.branch] || {};
    const comparable = !!(cl.asOn && cl.asOn === to);
    const tallyClosing = comparable ? (cl.amounts || {})[n] : undefined;
    loans.push({ ledger: meta.name || n, key: n, branch: meta.branch || '',
      kind: meta.kind, kindLabel: KIND_LABELS[meta.kind] || meta.kind,
      group: meta.group || '', branches: meta.branches || [],
      tally: { asOn: cl.asOn || null, comparable,
        closing: comparable ? r2(tallyClosing || 0) : null,
        diff: comparable ? r2(run - (tallyClosing || 0)) : null },
      opening: r2(opening[n]), drawn: tin, repaid: tout, closing: run,
      // The opening's two halves, so a disagreement with Tally says WHICH is wrong.
      openingParts: { tally: r2(openTally[n]), postings: r2(openPost[n]),
        byBranch: openByBranch[n] || {} },
      netChange: r2(run - opening[n]), sweep: isSweep(meta.kind),
      // A loan in DEBIT: repaid more than the account ever held. Either Tally really
      // carries it that way, or the opening is understated because vouchers between the
      // opening's own day and the window start are missing. Flagged rather than left for
      // somebody to notice, because it is the signature of a gap in the data.
      inDebit: run < -0.5,
      moved: !!(tin || tout), periods });
  }
  // Biggest closing first, and a loan with no movement and no balance last -- a page
  // opening on thirty dormant accounts buries the three that matter.
  loans.sort((a, b) => (Math.abs(b.closing) - Math.abs(a.closing))
    || (Math.abs(b.drawn + b.repaid) - Math.abs(a.drawn + a.repaid))
    || String(a.ledger).localeCompare(String(b.ledger)));

  // All borrowings together, same statement shape. Summed from the per-ledger cells, so
  // the total cannot disagree with the rows above it.
  // Each period carries the gross AND the split that keeps a sweeping OD out of the
  // headline: `drawnFacility`/`repaidFacility` are the real facilities, `sweepNet` is the
  // net move on the OD/CC accounts. closing = opening + drawnFacility - repaidFacility
  // + sweepNet, so the split reconciles exactly as the gross does.
  let runAll = loans.reduce((s, l) => r2(s + l.opening), 0);
  const openAll = runAll;
  const periods = keys.map((k, i) => {
    let din = 0, dout = 0, fin = 0, fout = 0, swp = 0;
    for (const l of loans) {
      const p = l.periods[i];
      din = r2(din + p.drawn); dout = r2(dout + p.repaid);
      if (l.sweep) swp = r2(swp + p.drawn - p.repaid);
      else { fin = r2(fin + p.drawn); fout = r2(fout + p.repaid); }
    }
    const o = runAll;
    runAll = r2(o + din - dout);
    return { key: k, label: bucketLabel(k, bucket), opening: r2(o), drawn: din, repaid: dout,
      drawnFacility: fin, repaidFacility: fout, sweepNet: swp,
      netChange: r2(din - dout), closing: runAll };
  });

  // EACH KIND, PERIOD BY PERIOD. The dashboard's main question is not "what do we owe"
  // but "which kind of borrowing is moving, and when" -- export credit turning over fast
  // while term debt amortises is two different stories inside one total. Summed from the
  // same per-loan cells as everything else, so no view can disagree with another.
  const byKindPeriods = {};
  for (const l of loans) {
    const series = byKindPeriods[l.kind] || (byKindPeriods[l.kind] = keys.map((k, i) => ({
      key: k, label: bucketLabel(k, bucket), opening: 0, drawn: 0, repaid: 0, closing: 0, netChange: 0,
    })));
    for (let i = 0; i < keys.length; i++) {
      const p = l.periods[i];
      series[i].opening = r2(series[i].opening + p.opening);
      series[i].drawn = r2(series[i].drawn + p.drawn);
      series[i].repaid = r2(series[i].repaid + p.repaid);
      series[i].closing = r2(series[i].closing + p.closing);
    }
  }
  for (const kind of Object.keys(byKindPeriods)) {
    for (const p of byKindPeriods[kind]) p.netChange = r2(p.closing - p.opening);
  }

  const byKind = {};
  for (const l of loans) {
    const e = byKind[l.kind] || (byKind[l.kind] = { kind: l.kind, kindLabel: l.kindLabel,
      sweep: l.sweep, count: 0, opening: 0, drawn: 0, repaid: 0, netChange: 0, closing: 0,
      periods: byKindPeriods[l.kind] || [] });
    e.count++;
    e.opening = r2(e.opening + l.opening); e.drawn = r2(e.drawn + l.drawn);
    e.repaid = r2(e.repaid + l.repaid); e.closing = r2(e.closing + l.closing);
    e.netChange = r2(e.closing - e.opening);
  }

  const sweepLoans = loans.filter((l) => l.sweep);
  const facLoans = loans.filter((l) => !l.sweep);
  const total = {
    opening: openAll,
    drawn: loans.reduce((s, l) => r2(s + l.drawn), 0),
    repaid: loans.reduce((s, l) => r2(s + l.repaid), 0),
    // The headline figures: real facilities drawn and repaid, with the OD/CC sweep as one
    // net number instead of the company's turnover twice over.
    drawnFacility: facLoans.reduce((s, l) => r2(s + l.drawn), 0),
    repaidFacility: facLoans.reduce((s, l) => r2(s + l.repaid), 0),
    sweepNet: sweepLoans.reduce((s, l) => r2(s + l.netChange), 0),
    sweepOpening: sweepLoans.reduce((s, l) => r2(s + l.opening), 0),
    sweepClosing: sweepLoans.reduce((s, l) => r2(s + l.closing), 0),
    sweepAccounts: sweepLoans.length,
    netChange: r2(runAll - openAll),
    closing: runAll,
    openingParts: {
      tally: loans.reduce((s, l) => r2(s + l.openingParts.tally), 0),
      postings: loans.reduce((s, l) => r2(s + l.openingParts.postings), 0),
    },
  };
  const inDebit = loans.filter((l) => l.inDebit)
    .map((l) => ({ ledger: l.ledger, branch: l.branch, opening: l.opening, repaid: l.repaid, closing: l.closing }));
  // Where Tally's own closing is comparable and we do not match it, worst first. This is
  // the reconciliation the page exists to make possible, so it is computed rather than
  // left to be eyeballed down a column of a hundred accounts.
  const checked = loans.filter((l) => l.tally && l.tally.comparable);
  const disagree = checked.filter((l) => Math.abs(l.tally.diff) > 1)
    .map((l) => ({ ledger: l.ledger, branch: l.branch, ours: l.closing,
      tally: l.tally.closing, diff: l.tally.diff }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const tallyCheck = { asOn: (checked[0] && checked[0].tally.asOn) || null,
    compared: checked.length, agree: checked.length - disagree.length,
    differ: disagree.length,
    diffTotal: r2(disagree.reduce((s2, d) => s2 + d.diff, 0)), worst: disagree.slice(0, 20) };
  const dormant = loans.filter((l) => !l.moved && Math.abs(l.closing) < 0.5).length;
  return { bucket, from, to, buckets: keys.length, loans, periods,
    byKind: Object.values(byKind).sort((a, b) =>
      (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) || (Math.abs(b.closing) - Math.abs(a.closing))),
    total, openingAsOn, openingKnown, ignoredRows: ignored, inDebit, dormant, tallyCheck };
}

module.exports = { loanKind, nearMiss, isExportCredit, bucketKeyOf, bucketLabel, bucketsBetween,
  weekStart, buildLoanMovement, KIND_LABELS, KIND_ORDER, GROUP_KINDS, NAME_KINDS, EXPORT_KW, NOT_BORROWING };
