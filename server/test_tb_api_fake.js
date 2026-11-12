// GET /api/tb end to end, THROUGH the real ingest: what a live pull, a historical pull and
// a daily sync each leave behind, and what the trial balance then says about them.
//
// The arithmetic is pinned in test_tb_fake.js. What this file holds is the chain that had
// a link missing: a back-fill of an old year used to be forbidden to store its balances
// (one master document per branch -- they would have replaced the live ones), so no old
// year had an opening and no trial balance for it could exist. The fixture pushes an old
// year AFTER the live one and insists both survive, each answering for its own dates.

// Mongo expression and filter support, kept to what this endpoint's pipeline uses.
function valueAt(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
  return cur;
}
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = valueAt(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$ne' in cond && val === cond.$ne) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$nin' in cond && cond.$nin.includes(val)) return false;
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$gt' in cond && !(val > cond.$gt)) return false;
      if ('$lt' in cond && !(val < cond.$lt)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
function expr(doc, e) {
  if (e === null || typeof e === 'number' || typeof e === 'boolean') return e;
  if (typeof e === 'string') {
    if (e[0] !== '$') return e;
    return valueAt(doc, e.slice(1));
  }
  if (Array.isArray(e)) return e.map((x) => expr(doc, x));
  const op = Object.keys(e)[0], a = e[op];
  if (op === '$ifNull') { const r = expr(doc, a[0]); return (r == null) ? expr(doc, a[1]) : r; }
  if (op === '$objectToArray') { const o = expr(doc, a) || {}; return Object.keys(o).map((k) => ({ k, v: o[k] })); }
  if (op === '$concatArrays') return expr(doc, a).reduce((x, y) => x.concat(y), []);
  if (op === '$cond') return expr(doc, a[0]) ? expr(doc, a[1]) : expr(doc, a[2]);
  if (op === '$gt') { const [x, y] = expr(doc, a); return x > y; }
  if (op === '$lt') { const [x, y] = expr(doc, a); return x < y; }
  if (op === '$lte') { const [x, y] = expr(doc, a); return x <= y; }
  if (op === '$multiply') return expr(doc, a).reduce((x, y) => x * y, 1);
  throw new Error('fake aggregate: unsupported operator ' + op);
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async findOne(filter = {}) { return this.docs.find((d) => matches(d, filter)) || null; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  find(filter = {}) {
    let arr = this.docs.filter((d) => matches(d, filter));
    const cur = { sort(spec) { const k = Object.keys(spec)[0], dir = spec[k];
        arr = arr.slice().sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0)); return cur; },
      limit(n) { arr = arr.slice(0, n); return cur; }, batchSize() { return cur; },
      project() { return cur; }, async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
    return cur;
  }
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) { Object.assign(f, set); for (const k of Object.keys(update.$unset || {})) delete f[k];
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async bulkWrite(ops) {
    let u = 0, ma = 0;
    for (const o of ops) { const r = await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert });
      u += r.upsertedCount; ma += r.matchedCount; }
    return { upsertedCount: u, matchedCount: ma, modifiedCount: ma };
  }
  async deleteMany(filter = {}) { const n = this.docs.length; this.docs = this.docs.filter((d) => !matches(d, filter));
    return { deletedCount: n - this.docs.length }; }
  async deleteOne(filter = {}) { const i = this.docs.findIndex((d) => matches(d, filter));
    if (i < 0) return { deletedCount: 0 }; this.docs.splice(i, 1); return { deletedCount: 1 }; }
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$match) { rows = rows.filter((d) => matches(d, st.$match)); continue; }
      if (st.$project) {
        rows = rows.map((d) => {
          const o = {};
          for (const [k, v] of Object.entries(st.$project)) o[k] = (v === 1) ? d[k] : expr(d, v);
          return o;
        });
        continue;
      }
      if (st.$unwind) {
        const path = String(st.$unwind).replace(/^\$/, ''), next = [];
        for (const d of rows) for (const item of (d[path] || [])) next.push({ ...d, [path]: item });
        rows = next;
        continue;
      }
      if (st.$group) {
        const spec = st.$group, byKey = new Map();
        for (const d of rows) {
          const id = (spec._id && typeof spec._id === 'object')
            ? Object.fromEntries(Object.keys(spec._id).map((k) => [k, expr(d, spec._id[k])]))
            : expr(d, spec._id);
          const key = JSON.stringify(id);
          let acc = byKey.get(key);
          if (!acc) { acc = { _id: id }; byKey.set(key, acc); }
          for (const f of Object.keys(spec)) {
            if (f === '_id') continue;
            const o = Object.keys(spec[f])[0], v = expr(d, spec[f][o]);
            if (o === '$sum') acc[f] = (acc[f] || 0) + (typeof v === 'number' ? v : 0);
          }
        }
        rows = [...byKey.values()];
        continue;
      }
      throw new Error('fake aggregate: unsupported stage ' + Object.keys(st)[0]);
    }
    return { async toArray() { return rows; } };
  }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.PORT = '0';
const app = require('./server');
const { ingest, syncIncremental, resetBranch } = require('./ingest');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= 0.5;
const L = 100000;

let n = 0;
const V = (date, type, pl, ld, extra) => ({ guid: 'g' + (++n), date, no: 'V' + n, type, party: '',
  party_ledgers: pl || {}, ledgers: ld || {}, ...(extra || {}) });

const GROUPS = { 'Bank Accounts': 'Current Assets', 'Sundry Debtors': 'Current Assets', 'Current Assets': null,
  'Capital Account': null, 'Sales Accounts': null, 'Indirect Expenses': null };

(async () => {
  // ---- the LIVE company, FY 2025-26 ---------------------------------------
  const liveMaster = {
    ledgers: { 'HDFC Bank': 'Bank Accounts', 'Capital': 'Capital Account', 'Customer A': 'Sundry Debtors',
      'Sale - Printing': 'Sales Accounts', 'Rent': 'Indirect Expenses' },
    groups: GROUPS, ids: {},
    vtypes: { 'Sales': '', 'Receipt': '', 'Payment': '', 'Sales Order': '', 'Proforma': 'Sales Order', 'Journal': '' },
    opening: { 'HDFC Bank': -10 * L, 'Capital': 10 * L }, openingAsOn: '20250401',
    closing: { 'HDFC Bank': -11.2 * L, 'Capital': 10 * L, 'Customer A': -0.5 * L, 'Sale - Printing': 2 * L, 'Rent': -0.3 * L },
    closingAsOn: '20260331',
    snapshots: [{ from: '20250401', to: '20260331', company: 'CDC PRINTERS 2025-26',
      opening: { 'HDFC Bank': -10 * L, 'Capital': 10 * L },
      closing: { 'HDFC Bank': -11.2 * L, 'Capital': 10 * L, 'Customer A': -0.5 * L, 'Sale - Printing': 2 * L, 'Rent': -0.3 * L } }],
    failedDays: [],
  };
  const live = [
    V('20250610', 'Sales', { 'Customer A': -2 * L }, { 'Sale - Printing': 2 * L }),
    V('20250815', 'Payment', { 'HDFC Bank': 0.3 * L }, { 'Rent': -0.3 * L }),
    V('20251120', 'Receipt', { 'HDFC Bank': -1.5 * L, 'Customer A': 1.5 * L }, {}),
    // An ORDER carries the amounts it would post, and posts nothing. Its type was created
    // from Sales Order under a name that does not say so.
    V('20250701', 'Proforma', { 'Customer A': -9 * L }, { 'Sale - Printing': 9 * L }),
    // Drafts reach no report in Tally and must reach none here.
    V('20250702', 'Sales', { 'Customer A': -7 * L }, { 'Sale - Printing': 7 * L }, { cancelled: true }),
    V('20250703', 'Sales', { 'Customer A': -5 * L }, { 'Sale - Printing': 5 * L }, { optional: true }),
  ];
  const r1 = await ingest({ branch: 'kol', from: '20250401', to: '20260331', master: liveMaster, vouchers: live });
  assert(r1.snapshots === 1, 'a live pull stores the balance snapshot for its period');

  // ---- an OLD year, pushed AFTERWARDS as a back-fill ----------------------
  // In 2019 the customer ledger sat under a different group, and there was a ledger
  // (Old Loan) the live company no longer has at all.
  const oldMaster = {
    ledgers: { 'HDFC Bank': 'Bank Accounts', 'Capital': 'Capital Account', 'Customer A': 'Export Debtors',
      'Sale - Printing': 'Sales Accounts', 'Old Loan': 'Loans (Liability)' },
    groups: { ...GROUPS, 'Export Debtors': 'Sundry Debtors', 'Loans (Liability)': null },
    vtypes: { 'Sales': '', 'Journal': '' },
    snapshots: [{ from: '20190401', to: '20200331', company: 'CDC PRINTERS 2019-20',
      opening: { 'HDFC Bank': -4 * L, 'Old Loan': 1 * L, 'Capital': 3 * L },
      closing: { 'HDFC Bank': -4 * L, 'Old Loan': 1 * L, 'Capital': 3 * L, 'Customer A': -6 * L, 'Sale - Printing': 6 * L } }],
    failedDays: ['20191005'],
  };
  const old = [V('20190920', 'Sales', { 'Customer A': -6 * L }, { 'Sale - Printing': 6 * L })];
  const r2 = await ingest({ branch: 'kol', from: '20190401', to: '20200331', master: oldMaster, masterMode: 'merge', vouchers: old });
  assert(r2.snapshots === 1, 'a HISTORICAL pull stores its own year\'s snapshot -- the thing it is the only source of');

  const bal = fakeDb.collection('balances').docs;
  assert(bal.length === 2, 'and the two periods sit side by side, neither replacing the other');
  const m = fakeDb.collection('masters').docs.find((d) => d.branch === 'kol');
  assert(m.opening['HDFC Bank'] === -10 * L && m.openingAsOn === '20250401',
    'the live master\'s own opening is untouched by the back-fill, as it always had to be');
  assert(m.ledgers['Customer A'] === 'Sundry Debtors', 'and so is the live chart of accounts');

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await (await fetch(base + p)).json());

  // ---- what it refuses -----------------------------------------------------
  assert((await get('/api/tb?branch=all&date=20250930')).ok === false,
    'a consolidated trial balance is refused: Tally has none to check it against');
  assert(/date/.test((await get('/api/tb?branch=kol')).error || ''), 'and a date is required rather than guessed at');
  const none = await get('/api/tb?branch=kol&date=20220615');
  assert(none.ok === false && none.noPeriod === true,
    'a date in a year whose balances were never pulled gets NO statement, not a neighbouring year\'s opening');
  assert(/2019-20/.test(none.error) && /2025-26/.test(none.error), 'and the refusal lists the years that ARE held');

  // ---- the live year, part-way through ------------------------------------
  const tb = await get('/api/tb?branch=kol&date=20250930');
  assert(tb.ok === true && tb.fy === '2025-26', 'a date in the live year is answered from the live year\'s opening');
  const row = (t, name) => t.rows.find((x) => x.ledger === name);
  assert(near(row(tb, 'Customer A').closing, -2 * L),
    'the customer owes 2,00,000 on 30 Sep -- the order, the cancelled sale and the optional one all left out');
  assert(near(row(tb, 'HDFC Bank').closing, -9.7 * L), 'the bank stands at 9,70,000 Dr');
  assert(near(tb.totals.closingDebit, tb.totals.closingCredit), 'and the statement balances');
  assert(tb.excludedTypes.some((x) => x.type === 'Proforma' && x.base === 'Sales Order' && x.vouchers === 1),
    'the order is reported as left out, with the reserved type that put it outside the books');
  assert(tb.typesJudgedBy === 'master', 'on the strength of Tally\'s own voucher-type master, not of its name');
  assert(tb.vouchers === 3, 'three vouchers post in the year');

  // ---- THE CHECK -----------------------------------------------------------
  assert(tb.check && tb.check.asOn === '20260331' && tb.check.mismatched === 0,
    'opening + every posting held lands on Tally\'s own closing for every ledger: the year is completely captured');

  // ---- the old year --------------------------------------------------------
  const ob = await get('/api/tb?branch=kol&date=20191231');
  assert(ob.ok === true && ob.fy === '2019-20' && ob.company === 'CDC PRINTERS 2019-20',
    'a date in 2019 is answered from the 2019-20 company\'s own opening');
  assert(near(row(ob, 'Old Loan').closing, 1 * L), 'including a ledger the live company no longer has');
  assert(row(ob, 'Customer A').chain.join(' > ') === 'Current Assets > Sundry Debtors > Export Debtors',
    'and each ledger sits where it sat THAT year, not where it sits today');
  assert(ob.check.mismatched === 0, 'that year reconciles to Tally too');
  assert((ob.notes || []).some((x) => /20191005/.test(x)),
    'and the day the Day Book would not answer for is named on the period it belongs to');

  // ---- a voucher we do NOT hold is found by the check ----------------------
  fakeDb.collection('vouchers').docs = fakeDb.collection('vouchers').docs.filter((d) => d.date !== '20250815');
  const gap = await get('/api/tb?branch=kol&date=20250930');
  assert(gap.check.mismatched === 2 && gap.check.mismatches.some((x) => x.ledger === 'Rent'),
    'lose one payment and the check names the two ledgers it posted to');

  // ---- the daily sync refreshes the current period -------------------------
  const r3 = await syncIncremental({ branch: 'kol', changedDates: [], vouchers: [], lastAlterId: 9,
    master: { ...liveMaster, snapshots: [{ from: '20250401', to: '20260331', company: 'CDC PRINTERS 2025-26',
      opening: liveMaster.snapshots[0].opening, closing: { ...liveMaster.snapshots[0].closing, 'Rent': -0.4 * L } }] } });
  assert(r3.snapshots === 1 && fakeDb.collection('balances').docs.length === 2,
    'the daily sync refreshes its own period in place and adds no duplicate');

  // ---- coverage ------------------------------------------------------------
  const cov = await get('/api/tb/coverage');
  assert(cov.ok && cov.branches.kol.periods.length === 2 && cov.branches.kol.periods[0].fy === '2019-20',
    'coverage lists the periods a trial balance can be drawn for, oldest first');
  assert(cov.branches.ahm.periods.length === 0, 'and says plainly that a company has none');
  assert(cov.branches.kol.firstVoucher === '20190920', 'beside the oldest voucher actually held');

  // ---- a reset of the wrong company takes its balances with it -------------
  const rr = await resetBranch({ branch: 'kol', from: '20190401', to: '20200331' });
  assert(rr.balancesDeleted === 1 && fakeDb.collection('balances').docs.length === 1,
    'resetting a year removes that year\'s balance snapshot and no other');

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== trial balance API passed ==');
  process.exit(fails ? 1 : 0);
})();
