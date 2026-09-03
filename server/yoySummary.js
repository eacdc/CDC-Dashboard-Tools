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
function newSummary(xd, aliases) {
  const lu = E.buildLookups(xd);
  return {
    xd, lu,
    // The dashboards merge a party renamed in Tally (or entered twice) into one name
    // before adding anything up. This has to do the same, or a customer is whole on
    // the P&L tab and split across two rows here -- and searching the name that lost
    // finds nothing on one page while the other still shows it.
    canon: E.makeCanon(xd, aliases),
    ib: E.findIBLedgers(xd),          // inter-branch ledgers, dropped from consolidated
    cat: new Map(),                    // ledger -> P&L category, memoised
    chain: new Map(),                  // ledger -> is it a bank/cash/OD account
    data: {},                          // branch -> fy -> line -> [12]
    // The same amounts again, but kept per ledger, so a line can be opened down to
    // the accounts under it. Only the two real branches are held: 'all' is built at
    // the end by merging them, which costs nothing to accumulate.
    detail: { kol: {}, ahm: {} },      // branch -> line -> ledger -> fy -> [12]
    // The Sales Analysis view again, year on year: each sale attributed to its
    // Sundry-DEBTOR party and each purchase to its Sundry-CREDITOR one, so the tree
    // opens salesperson -> company -> party rather than by income account.
    //
    // 'all' is accumulated here rather than merged afterwards, because consolidated
    // is not the sum of the two branches: dropping the inter-branch ledgers changes
    // which party is DOMINANT in a voucher, and the dominant party is who the whole
    // invoice is attributed to. The dashboard makes the same distinction -- its
    // branch filter clears ibLedgers when one branch is shown alone.
    party: { kol: {}, ahm: {}, all: {} },  // branch -> 'section|measure' -> party -> fy -> [12]
    acct: new Map(),                   // ledger -> 'sales' | 'purchase' | null
    sundry: new Map(),                 // party  -> 'debtor' | 'creditor' | null
    vouchers: 0,
  };
}
// One ledger's contribution to one line, in one month of one year. Kept sparse by
// year -- an account that traded in two of eleven years holds two arrays, not eleven.
function addDetail(S, branch, line, name, fy, mi, amt) {
  const b = S.detail[branch];
  if (!b) return;                      // a voucher tagged with neither branch
  const l = b[line] || (b[line] = {});
  const led = l[name] || (l[name] = {});
  const arr = led[fy] || (led[fy] = new Array(12).fill(0));
  arr[mi] += amt;
}
// Which ledgers are Sales / Purchase Accounts, for the P&L-basis measure. classify()
// also tags shipping, freight and other incomes as 'revenue', and the Net (P&L)
// measure deliberately leaves those out so it ties to the P&L's Sales line.
function acctOf(S, name) {
  let v = S.acct.get(name);
  if (v === undefined) {
    const ch = E.getChain(name, S.xd, S.lu);
    v = ch.indexOf('Sales Accounts') >= 0 ? 'sales' : (ch.indexOf('Purchase Accounts') >= 0 ? 'purchase' : null);
    S.acct.set(name, v);
  }
  return v;
}
function sundryOf(S, name) {
  let v = S.sundry.get(name);
  if (v === undefined) {
    const ch = E.getChain(name, S.xd, S.lu).join('>').toLowerCase();
    v = ch.indexOf('sundry debtors') >= 0 ? 'debtor' : (ch.indexOf('sundry creditors') >= 0 ? 'creditor' : null);
    S.sundry.set(name, v);
  }
  return v;
}
function addParty(S, branch, key, name, fy, mi, amt) {
  const b = S.party[branch];
  if (!b || !amt) return;
  const k = b[key] || (b[key] = {});
  const led = k[name] || (k[name] = {});
  const arr = led[fy] || (led[fy] = new Array(12).fill(0));
  arr[mi] += amt;
}
// One voucher's contribution to the party-anchored sections, for one scope (the
// voucher's own branch, and consolidated). Kept deliberately close to the
// dashboard's __saBuild: the same dominant-party rule, the same three measures, and
// abs() on the amounts so a party's size reads the same way in both places.
function addPartyVoucher(S, v, branch, fy, mi) {
  const ledgers = v.ledgers || {};
  const parties = v.party_ledgers || {};
  for (const scope of [branch, 'all']) {
    const dropIB = scope === 'all';
    let nr = 0, np = 0, nrPL = 0, npPL = 0;
    for (const ln in ledgers) {
      if (dropIB && S.ib[ln]) continue;
      const c = catOf(S, ln);
      if (c === 'revenue') { nr += ledgers[ln]; if (acctOf(S, ln) === 'sales') nrPL += ledgers[ln]; }
      else if (c === 'purchase') { np += ledgers[ln]; if (acctOf(S, ln) === 'purchase') npPL += ledgers[ln]; }
    }
    let dg = 0, cg = 0, dd = null, dda = 0, dc = null, dca = 0;
    for (const pn in parties) {
      if (dropIB && S.ib[pn]) continue;
      const av = Math.abs(parties[pn]);
      const s = sundryOf(S, pn);
      if (s === 'debtor') { dg += av; if (av > dda) { dda = av; dd = pn; } }
      else if (s === 'creditor') { cg += av; if (av > dca) { dca = av; dc = pn; } }
    }
    if (nr !== 0 && dd) {
      addParty(S, scope, 'sales|net', dd, fy, mi, Math.abs(nr));
      addParty(S, scope, 'sales|gross', dd, fy, mi, dg);
      if (nrPL !== 0) addParty(S, scope, 'sales|netpl', dd, fy, mi, Math.abs(nrPL));
    }
    if (np !== 0 && dc) {
      addParty(S, scope, 'purchase|net', dc, fy, mi, Math.abs(np));
      addParty(S, scope, 'purchase|gross', dc, fy, mi, cg);
      if (npPL !== 0) addParty(S, scope, 'purchase|netpl', dc, fy, mi, Math.abs(npPL));
    }
  }
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

// One voucher's ledger map with the names merged. Two spellings of one party on the
// same voucher add together, exactly as __cdcCanon's own key-merge does it.
function canonKeys(S, obj) {
  if (!obj) return {};
  const out = {};
  for (const k in obj) {
    const ck = S.canon(k);
    out[ck] = (out[ck] || 0) + obj[k];
  }
  return out;
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

  const ledgers = canonKeys(S, v.ledgers);
  const parties = canonKeys(S, v.party_ledgers);
  addPartyVoucher(S, { ledgers, party_ledgers: parties }, branch, fy, mi);
  for (const ln in ledgers) {
    const line = CAT2LINE[catOf(S, ln)];
    if (!line) continue;
    const amt = ledgers[ln];
    own[line][mi] += amt;
    if (!S.ib[ln]) all[line][mi] += amt;
    addDetail(S, branch, line, ln, fy, mi, amt);
  }
  // Expenses are sometimes booked on the party side; the P&L tab counts those too.
  for (const pn in parties) {
    const line = CAT2LINE[catOf(S, pn)];
    if (!line) continue;
    const amt = parties[pn];
    own[line][mi] += amt;
    if (!S.ib[pn]) all[line][mi] += amt;
    addDetail(S, branch, line, pn, fy, mi, amt);
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
    if (inAmt) { own.cashIn[mi] += inAmt; if (!S.ib[pn]) all.cashIn[mi] += inAmt; addDetail(S, branch, 'cashIn', pn, fy, mi, inAmt); }
    if (outAmt) { own.cashOut[mi] += outAmt; if (!S.ib[pn]) all.cashOut[mi] += outAmt; addDetail(S, branch, 'cashOut', pn, fy, mi, outAmt); }
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

// ---- the expandable trees ---------------------------------------------------
// One tree per branch per line, covering every year at once. The months of all the
// years lie end to end in a single array -- Apr of the first year at 0, Mar of the
// last at 12*n-1 -- which is exactly the layout the portal's buildTree already
// handles (it takes monthCount), and exactly what the year columns need: a year's
// total is the sum of its twelve slots, and opening a year reads those twelve.
//
// Sent sparse. A party that traded in one year of eleven would otherwise carry 132
// zeroes, and there are thousands of parties; { slot: amount } cuts the payload by
// an order of magnitude. expandYoyTree() in the portal puts the arrays back.
const TREE_LINES = ['revenue', 'purchase', 'directExp', 'indirectExp', 'cashIn', 'cashOut'];

function sparsify(node) {
  const m = {};
  for (let i = 0; i < node.monthly.length; i++) if (node.monthly[i]) m[i] = node.monthly[i];
  const out = { n: node.name, t: node.type === 'ledger' ? 'l' : 'g', m };
  if (node.children && node.children.length) out.c = node.children.map(sparsify);
  if (node.ledgers && node.ledgers.length) out.l = node.ledgers.map(sparsify);
  return out;
}

// Lay one branch's sparse-by-year detail out along the whole timeline.
function flatten(byLedger, fys, fyIndex) {
  const width = fys.length * 12;
  const out = {};
  for (const name of Object.keys(byLedger)) {
    const years = byLedger[name];
    const arr = new Array(width).fill(0);
    let any = false;
    for (const fy of Object.keys(years)) {
      const base = fyIndex[fy];
      if (base === undefined) continue;
      const src = years[fy];
      for (let i = 0; i < 12; i++) if (src[i]) { arr[base * 12 + i] += src[i]; any = true; }
    }
    if (any) out[name] = arr;
  }
  return out;
}

// Consolidated is the two branches added together with their claims on each other
// dropped -- the same rule the totals above use, applied to the ledgers themselves.
function mergeBranches(a, b, ib) {
  const out = {};
  for (const src of [a, b]) {
    for (const name of Object.keys(src)) {
      if (ib[name]) continue;
      const arr = out[name] || (out[name] = new Array(src[name].length).fill(0));
      for (let i = 0; i < arr.length; i++) arr[i] += src[name][i];
    }
  }
  return out;
}

// What gets STORED is this detail, not the finished trees. A rebuild of one year has
// to leave the other ten alone, and years can be spliced in and out of
// ledger -> { fy: [12] } the same way the totals are; a nested tree cannot. The tree
// itself is cheap to build (a few thousand ledgers, well under a second), so it is
// built when a line is opened rather than stored eleven ways.
function detailOf(S) {
  const out = {};
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const br of ['kol', 'ahm']) {
    for (const line of TREE_LINES) {
      const src = S.detail[br][line];
      if (!src) continue;
      const led = {};
      for (const name of Object.keys(src)) {
        const years = {};
        for (const fy of Object.keys(src[name])) {
          const a = src[name][fy].map(r2);
          if (a.some((v) => Math.abs(v) > 0.005)) years[fy] = a;
        }
        if (Object.keys(years).length) led[name] = years;
      }
      out[br + '|' + line] = led;
    }
  }
  return out;
}

// Replace only the years that were rescanned, dropping a ledger that no longer holds
// any. Mirrors what the totals do above, one level deeper.
function spliceDetail(prev, fresh, fys) {
  const touched = new Set(fys || []);
  const out = {};
  for (const name of Object.keys(prev || {})) {
    const years = {};
    for (const fy of Object.keys(prev[name])) if (!touched.has(fy)) years[fy] = prev[name][fy];
    if (Object.keys(years).length) out[name] = years;
  }
  for (const name of Object.keys(fresh || {})) {
    const years = out[name] || (out[name] = {});
    for (const fy of Object.keys(fresh[name])) years[fy] = fresh[name][fy];
  }
  for (const name of Object.keys(out)) if (!Object.keys(out[name]).length) delete out[name];
  return out;
}

// detail (one branch's ledger -> { fy: [12] }, or two to be consolidated) -> the tree
// the panel draws, sparse.
function treeFrom(detailPerBranch, xd, fys) {
  const fyIndex = {};
  fys.forEach((fy, i) => { fyIndex[fy] = i; });
  const width = fys.length * 12;
  const lu = E.buildLookups(xd);
  const flats = detailPerBranch.map((d) => flatten(d || {}, fys, fyIndex));
  const data = flats.length > 1 ? mergeBranches(flats[0], flats[1], E.findIBLedgers(xd)) : (flats[0] || {});
  return E.buildTree(data, xd, lu, width).map(sparsify);
}

// ---- the party-anchored sections --------------------------------------------
const PARTY_SECTIONS = { sales: 'Sundry Debtors', purchase: 'Sundry Creditors' };
const PARTY_MEASURES = ['netpl', 'net', 'gross'];
const PARTY_KEYS = [];
for (const b of ['kol', 'ahm', 'all']) {
  for (const s of Object.keys(PARTY_SECTIONS)) for (const m of PARTY_MEASURES) PARTY_KEYS.push(b + '|' + s + '|' + m);
}

function partyDetailOf(S) {
  const out = {};
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const branch of Object.keys(S.party)) {
    for (const key of Object.keys(S.party[branch])) {
      const src = S.party[branch][key];
      const led = {};
      for (const name of Object.keys(src)) {
        const years = {};
        for (const fy of Object.keys(src[name])) {
          const a = src[name][fy].map(r2);
          if (a.some((x) => Math.abs(x) > 0.005)) years[fy] = a;
        }
        if (Object.keys(years).length) led[name] = years;
      }
      out[branch + '|' + key] = led;
    }
  }
  // A branch/section/measure with no activity at all still gets an entry, so a
  // rebuild that empties one clears the stored document instead of leaving it stale.
  for (const k of PARTY_KEYS) if (!out[k]) out[k] = {};
  return out;
}

function findNode(nodes, name) {
  for (const n of nodes || []) {
    if (n.name === name) return n;
    const f = n.children && findNode(n.children, name);
    if (f) return f;
  }
  return null;
}

// The Sundry-rooted subtree, sparse, plus that root's own months so the section
// header can show the same total the P&L-side lines show.
//
// Whole-hierarchy buildTree first and then lift the root out, exactly as the
// dashboard's __saSection does -- the parties have to nest under their real Tally
// groups (the salesperson group, then the company under it) and only buildTree
// knows that shape.
function partyTreeFrom(byLedger, xd, fys, section) {
  const rootName = PARTY_SECTIONS[section];
  if (!rootName) throw new Error(`partyTreeFrom: unknown section "${section}"`);
  const fyIndex = {};
  fys.forEach((fy, i) => { fyIndex[fy] = i; });
  const lu = E.buildLookups(xd);
  const flat = flatten(byLedger || {}, fys, fyIndex);
  const node = findNode(E.buildTree(flat, xd, lu, fys.length * 12), rootName);
  if (!node) return { root: {}, tree: [] };
  const s = sparsify(node);
  return { root: s.m, tree: (s.c || []).concat(s.l || []) };
}

function summarise(vouchers, xd, aliases) {
  const S = newSummary(xd, aliases);
  for (const v of vouchers || []) addVoucher(S, v);
  return finalize(S);
}

module.exports = {
  newSummary, addVoucher, finalize, summarise,
  detailOf, spliceDetail, treeFrom,
  partyDetailOf, partyTreeFrom, PARTY_SECTIONS, PARTY_MEASURES, PARTY_KEYS,
  fyOf, fyLabel, monthOf, LINES, TREE_LINES,
};
