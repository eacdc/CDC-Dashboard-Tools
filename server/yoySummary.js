// Year-on-year P&L and cashflow totals, folded from every voucher in one pass.
//
// The dashboards compute these in the browser from the vouchers of ONE financial
// year. A decade of history cannot travel to a browser, so the same figures are
// folded here instead and stored as a few thousand numbers -- small enough for the
// landing page to open instantly, month detail included.
//
// The classification is not re-implemented: plEngine lifts the dashboard's own
// classify/getChain out of the portal, so a ledger lands in the same bucket here as
// it does on the P&L tab. test_yoy_fake.js then checks the aggregate matches the
// browser's processData figure for figure.
//
// Two things the browser has and this does not, both deliberate:
//   * stock change comes from an uploaded template covering the current period only,
//     so it is not folded here. GP = revenue + purchases + direct expenses.
//   * per-browser ledger/invoice overrides live in localStorage and cannot be seen
//     from the server, so the un-overridden classification is used.
'use strict';
const E = require('./plEngine');

const LINES = ['revenue', 'purchase', 'directExp', 'indirectExp', 'cashIn', 'cashOut'];
const CAT2LINE = { revenue: 'revenue', purchase: 'purchase', direct_expense: 'directExp', indirect_expense: 'indirectExp' };
const RCV = { 'Bank Receipt': 1, Receipt: 1 };
const PAY = { 'Bank Payments': 1, 'Bank Payment': 1, 'Cash Paynent': 1, 'Cash Payment': 1, 'Cash Voucher': 1, Payment: 1 };
const BANK = ['bank accounts', 'cash-in-hand', 'cash-in hand'];
const OD = ['bank od', 'bank occ'];

function fyOf(date) {
  const y = parseInt(String(date).substring(0, 4), 10);
  const m = parseInt(String(date).substring(4, 6), 10);
  return (m >= 4 ? y : y - 1);
}
function fyLabel(fy) { return fy + '-' + String((fy + 1) % 100).padStart(2, '0'); }
function monthOf(date) { return (parseInt(String(date).substring(4, 6), 10) - 4 + 12) % 12; }

// xd = the merged ledger hierarchy (both branches, hist included). Everything that
// only depends on the hierarchy is worked out once here, not per voucher.
function newSummary(xd) {
  const lu = E.buildLookups(xd);
  return {
    xd, lu,
    ib: E.findIBLedgers(xd),          // inter-branch ledgers, dropped from consolidated
    cat: new Map(),                    // ledger -> P&L category, memoised
    chain: new Map(),                  // ledger -> is it a bank/cash/OD account
    data: {},                          // branch -> fy -> line -> [12]
    vouchers: 0,
  };
}
function bucket(S, branch, fy) {
  const b = S.data[branch] || (S.data[branch] = {});
  let f = b[fy];
  if (!f) { f = b[fy] = {}; for (const l of LINES) f[l] = new Array(12).fill(0); }
  return f;
}
function catOf(S, name) {
  let c = S.cat.get(name);
  if (c === undefined) { c = E.classify(name, S.xd, S.lu, {}); S.cat.set(name, c); }
  return c;
}
// A bank, cash or overdraft account is the OTHER side of a receipt/payment, not a
// flow in its own right -- counting it would double every cash movement.
function isCashAccount(S, name) {
  let v = S.chain.get(name);
  if (v === undefined) {
    const ch = E.getChain(name, S.xd, S.lu).join('>').toLowerCase();
    v = BANK.some((k) => ch.indexOf(k) >= 0) || OD.some((k) => ch.indexOf(k) >= 0);
    S.chain.set(name, v);
  }
  return v;
}

function addVoucher(S, v) {
  if (!v || !v.date) return S;
  const branch = v.branch || v._branch;
  if (!branch) return S;
  const fy = fyLabel(fyOf(v.date));
  const mi = monthOf(v.date);
  S.vouchers++;
  // Every voucher lands twice: in its own branch, and in the consolidated view --
  // where the two branches' claims on each other are dropped, exactly as the
  // dashboard's branch filter does it.
  const own = bucket(S, branch, fy);
  const all = bucket(S, 'all', fy);

  const ledgers = v.ledgers || {};
  const parties = v.party_ledgers || {};
  for (const ln in ledgers) {
    const line = CAT2LINE[catOf(S, ln)];
    if (!line) continue;
    const amt = ledgers[ln];
    own[line][mi] += amt;
    if (!S.ib[ln]) all[line][mi] += amt;
  }
  // Expenses are sometimes booked on the party side; the P&L tab counts those too.
  for (const pn in parties) {
    const line = CAT2LINE[catOf(S, pn)];
    if (!line) continue;
    const amt = parties[pn];
    own[line][mi] += amt;
    if (!S.ib[pn]) all[line][mi] += amt;
  }

  if (!E.CASH_VCH[v.type]) return S;
  const isR = !!RCV[v.type], isP = !!PAY[v.type], isC = v.type === 'Contra';
  const seen = {};
  for (const k in parties) seen[k] = parties[k];
  for (const k in ledgers) if (!Object.prototype.hasOwnProperty.call(seen, k)) seen[k] = ledgers[k];
  for (const pn in seen) {
    if (isCashAccount(S, pn)) continue;
    const raw = seen[pn];
    let inAmt = 0, outAmt = 0;
    if (isR) inAmt = raw;
    else if (isP) outAmt = -raw;
    else if (isC) { const cv = -raw; if (cv > 0) inAmt = cv; else outAmt = Math.abs(cv); }
    else continue;
    if (inAmt) { own.cashIn[mi] += inAmt; if (!S.ib[pn]) all.cashIn[mi] += inAmt; }
    if (outAmt) { own.cashOut[mi] += outAmt; if (!S.ib[pn]) all.cashOut[mi] += outAmt; }
  }
  return S;
}

// Round, add the derived lines, and lay it out for the client: one row per line,
// twelve months plus the year total.
function finalize(S) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const out = { fys: [], branches: {}, vouchers: S.vouchers };
  const fySet = new Set();
  for (const branch of Object.keys(S.data)) for (const fy of Object.keys(S.data[branch])) fySet.add(fy);
  out.fys = [...fySet].sort();
  for (const branch of Object.keys(S.data)) {
    const b = out.branches[branch] = {};
    for (const fy of Object.keys(S.data[branch])) {
      const f = S.data[branch][fy];
      const row = {};
      for (const l of LINES) row[l] = f[l].map(r2);
      // Same formulas as the P&L tab, minus the stock term it gets from a template.
      row.gp = row.revenue.map((_, i) => r2(row.revenue[i] + row.purchase[i] + row.directExp[i]));
      row.np = row.gp.map((g, i) => r2(g + row.indirectExp[i]));
      row.cashNet = row.cashIn.map((v, i) => r2(v - row.cashOut[i]));
      row.totals = {};
      for (const k of Object.keys(row)) {
        if (k === 'totals') continue;
        row.totals[k] = r2(row[k].reduce((a, x) => a + x, 0));
      }
      // How far into the year the data actually goes. The financial year in progress
      // holds only the months booked so far, and comparing five months against a
      // full twelve reads as a collapse that never happened -- so the client needs
      // to know, and compares like for like instead.
      row.lastMonth = -1;
      for (let i = 0; i < 12; i++) {
        for (const l of LINES) if (Math.abs(row[l][i]) > 0.005) { row.lastMonth = Math.max(row.lastMonth, i); break; }
      }
      b[fy] = row;
    }
  }
  return out;
}

function summarise(vouchers, xd) {
  const S = newSummary(xd);
  for (const v of vouchers || []) addVoucher(S, v);
  return finalize(S);
}

module.exports = { newSummary, addVoucher, finalize, summarise, fyOf, fyLabel, monthOf, LINES };
