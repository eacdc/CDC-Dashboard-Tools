// Tests the party-merge suggester on hand-built cases (no DB, no network).
//
// The cases are the ones that decide whether this feature is useful or dangerous:
// a genuine rename across financial years must be found, two sister concerns that
// merely look alike must NOT be, and one mistyped GSTIN must not marry two firms.
const { suggestAliases, profileLedgers, panOf, tokens } = require('./aliasSuggest');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

// A voucher touching one party. gstin/ref are optional.
const V = (date, party, amt, gstin, ref) => ({
  date, type: 'Sales', no: date + party.slice(0, 3),
  ledgers: { Sales: amt }, party_ledgers: { [party]: -amt },
  details: gstin ? { partyGstin: gstin } : {},
  bills: ref ? [{ ledger: party, ref, type: 'New Ref', amount: -amt }] : [],
});
const find = (out, a, b) => out.suggestions.find(
  (s) => (s.variant === a && s.canonical === b) || (s.variant === b && s.canonical === a));

const GST_GLEE = '19AABCG1234M1Z5';
const GST_MODERN = '19AAACM5678K1Z9';
const GST_HERBO_MH = '27AAACM5678K1Z1'; // same PAN as MODERN, Maharashtra registration

const vouchers = [
  // 1. A real rename: "M/S Gleebuds" stops in FY22, "Gleebuds Paper Pvt Ltd" starts.
  V('20210510', 'M/S Gleebuds', 100000, GST_GLEE, 'GB/1'),
  V('20211220', 'M/S Gleebuds', 120000, GST_GLEE, 'GB/2'),
  V('20230715', 'Gleebuds Paper Pvt Ltd', 150000, GST_GLEE, 'GB/9'),
  V('20240220', 'Gleebuds Paper Pvt Ltd', 160000, GST_GLEE, 'GB/10'),

  // 2. Two sister concerns: near-identical names, BOTH trading right now, different
  //    GSTINs under different PANs. Must never be merged.
  V('20250601', 'Sunrise Papers', 90000, '19AAECS1111A1Z1', 'SP/1'),
  V('20250605', 'Sunrise Paper Mills', 95000, '19AAFCS2222B1Z2', 'SM/1'),
  V('20260101', 'Sunrise Papers', 80000, '19AAECS1111A1Z1', 'SP/2'),
  V('20260105', 'Sunrise Paper Mills', 85000, '19AAFCS2222B1Z2', 'SM/2'),

  // 3. One mistyped GSTIN: a single "Alpha Steel" voucher carries Gleebuds' GSTIN.
  //    One stray value out of many must not make Alpha Steel a Gleebuds alias.
  V('20250701', 'Alpha Steel', 50000, GST_GLEE, 'AS/1'),
  V('20250801', 'Alpha Steel', 51000, '19AAKCA9999Z1Z3', 'AS/2'),
  V('20250901', 'Alpha Steel', 52000, '19AAKCA9999Z1Z3', 'AS/3'),
  V('20251001', 'Alpha Steel', 53000, '19AAKCA9999Z1Z3', 'AS/4'),

  // 4. Same company, second state registration (same PAN). Worth offering, but not
  //    as "certain" -- they may be kept apart on purpose.
  V('20250301', 'Modern Herbo', 70000, GST_MODERN, 'MH/1'),
  V('20250401', 'Modern Herbo', 71000, GST_MODERN, 'MH/2'),
  V('20260301', 'Modern Herbo Maharashtra', 72000, GST_HERBO_MH, 'MHM/1'),
  V('20260401', 'Modern Herbo Maharashtra', 73000, GST_HERBO_MH, 'MHM/2'),

  // 5. No GSTIN anywhere, but a receipt under the new name settles a bill opened
  //    under the old one -- Tally's own word that they are one party.
  { date: '20220101', type: 'Sales', no: 'OLD1', ledgers: { Sales: 40000 }, party_ledgers: { 'Bharat Traders': -40000 },
    details: {}, bills: [{ ledger: 'Bharat Traders', ref: 'BT/77', type: 'New Ref', amount: -40000 }] },
  { date: '20240101', type: 'Bank Receipt', no: 'RC1', ledgers: { Bank: 40000 }, party_ledgers: { 'Bharat Trading Co': 40000 },
    details: {}, bills: [{ ledger: 'Bharat Trading Co', ref: 'BT/77', type: 'Agst Ref', amount: 40000 }] },

  // 6. A creditor whose name resembles a debtor's. Same side only, never across.
  V('20250401', 'Gleebuds Transport', 20000, null, 'GT/1'),
];

const contacts = {
  'M/S Gleebuds': { mobile: '98300 11111', email: 'accounts@gleebuds.in' },
  'Gleebuds Paper Pvt Ltd': { mobile: '9830011111', email: 'accounts@gleebuds.in' },
  'Sunrise Papers': { mobile: '9000000001' },
  'Sunrise Paper Mills': { mobile: '9000000002' },
};
const groups = {
  'M/S Gleebuds': 'Sundry Debtors', 'Gleebuds Paper Pvt Ltd': 'Sundry Debtors',
  'Sunrise Papers': 'Sundry Debtors', 'Sunrise Paper Mills': 'Sundry Debtors',
  'Alpha Steel': 'Sundry Debtors',
  'Modern Herbo': 'Sundry Debtors', 'Modern Herbo Maharashtra': 'Sundry Debtors',
  'Bharat Traders': 'Sundry Debtors', 'Bharat Trading Co': 'Sundry Debtors',
  'Gleebuds Transport': 'Sundry Creditors',
};

// ---- unit checks -----------------------------------------------------------
assert(panOf(GST_MODERN) === 'AAACM5678K' && panOf(GST_HERBO_MH) === 'AAACM5678K', 'PAN extracted from GSTIN, state digits dropped');
assert(panOf('not-a-gstin') === null, 'a non-GSTIN yields no PAN');
assert(tokens('M/S Gleebuds Paper Pvt. Ltd.').join(' ') === 'gleebuds paper', 'legal-form words stripped, trade words kept');
const prof = profileLedgers(vouchers);
assert(prof['Alpha Steel'].gstin === '19AAKCA9999Z1Z3', 'a ledger takes its DOMINANT gstin, not a one-off typo');
assert(prof['M/S Gleebuds'].first === '20210510' && prof['M/S Gleebuds'].last === '20211220', 'activity window tracked per ledger');

// ---- the suggestions -------------------------------------------------------
const out = suggestAliases({ vouchers, contacts, groups, existing: {} });
console.log('\nsuggestions:');
for (const s of out.suggestions) console.log(`  ${s.tier.padEnd(8)} ${s.confidence}  ${s.variant}  ->  ${s.canonical}\n            ${s.evidence.join(' | ')}`);
console.log('');

const rename = find(out, 'M/S Gleebuds', 'Gleebuds Paper Pvt Ltd');
assert(!!rename, 'the genuine rename is found');
assert(rename && rename.tier === 'certain', 'rename is offered as "certain" (same GSTIN, no overlap)');
assert(rename && rename.canonical === 'Gleebuds Paper Pvt Ltd', 'the CURRENT name is the canonical one, not the old one');

assert(!find(out, 'Sunrise Papers', 'Sunrise Paper Mills'), 'sister concerns with different PANs are never offered');
assert(!find(out, 'Alpha Steel', 'M/S Gleebuds') && !find(out, 'Alpha Steel', 'Gleebuds Paper Pvt Ltd'),
  'one mistyped GSTIN does not marry two firms');
assert(!find(out, 'Gleebuds Transport', 'Gleebuds Paper Pvt Ltd'), 'a creditor is never merged into a debtor');

const pan = find(out, 'Modern Herbo', 'Modern Herbo Maharashtra');
assert(!!pan, 'the second-state registration is offered');
assert(pan && pan.tier !== 'certain', 'same PAN / different GSTIN is offered as a question, not a certainty');

const bill = find(out, 'Bharat Traders', 'Bharat Trading Co');
assert(!!bill, 'a shared bill reference alone finds the pair, with no GSTIN at all');
assert(bill && bill.canonical === 'Bharat Trading Co', 'the name carrying the recent receipt is canonical');
assert(bill && bill.evidence.some((x) => /shared bill ref/.test(x)), 'the evidence names the shared reference');

// ---- suppression of settled pairs -----------------------------------------
const after = suggestAliases({ vouchers, contacts, groups, existing: { 'M/S Gleebuds': 'Gleebuds Paper Pvt Ltd' } });
assert(!find(after, 'M/S Gleebuds', 'Gleebuds Paper Pvt Ltd'), 'a pair already in the alias map is not offered again');

// ---- scale ------------------------------------------------------------------
// 300 name families, each holding a genuine rename (one GSTIN, disjoint years)
// plus 8 lookalikes trading alongside the new name. Every family shares the token
// "Trading" with all the others, so the pair-explosion guard has to hold that back
// while the narrower per-family blocks still do their work.
const gst = (n) => '19AAAC' + String.fromCharCode(65 + (n % 26)) + String(1000 + n).slice(-4) + 'M1Z5';
const many = [];
for (let f = 0; f < 300; f++) {
  const old = 'Zenith' + f + ' Papers Trading', now = 'Zenith' + f + ' Paper Pvt Ltd Trading';
  many.push(V('20230501', old, 1000 + f, gst(f), 'O' + f + 'a'), V('20230901', old, 1100 + f, gst(f), 'O' + f + 'b'));
  many.push(V('20250501', now, 1200 + f, gst(f), 'N' + f + 'a'), V('20250901', now, 1300 + f, gst(f), 'N' + f + 'b'));
  for (let k = 0; k < 8; k++) many.push(V('20250601', 'Zenith' + f + ' Stores ' + k + ' Trading', 900 + k, null, 'S' + f + k));
}
const t0 = Date.now();
const big = suggestAliases({ vouchers: many, contacts: {}, groups: {}, limit: 5000 });
const ms = Date.now() - t0;
const certain = big.suggestions.filter((s) => s.tier === 'certain');
console.log(`\n3300 ledgers scanned in ${ms} ms: ${big.total} candidate(s), ${certain.length} certain`);
assert(ms < 5000, '3300 ledgers scan in under 5s (blocking works, not O(n^2) on strings)');
assert(certain.length === 300, 'all 300 planted renames found, and only those, as "certain"');
assert(!big.suggestions.some((s) => /Stores/.test(s.variant) && s.tier === 'certain'),
  'lookalikes trading alongside the new name never reach "certain" on resemblance alone');

console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== alias suggestion logic passed ==');
process.exit(fails ? 1 : 0);
