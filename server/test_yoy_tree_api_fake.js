// The two endpoints behind the year-on-year drill-down, against a stubbed Mongo:
//   GET /api/yoy/tree      -- the accounts under one line, every year at once
//   GET /api/yoy/vouchers  -- the vouchers behind one account for one period
//
// The figures themselves are checked in test_yoy_tree_fake.js (tree adds up to line)
// and test_yoy_fake.js (line matches the browser). What is checked here is the
// plumbing: that a rebuild stores the detail, that consolidated merges the branches,
// that a partial rebuild does not wipe the other years' detail, and that a ledger
// name carrying a dot -- which a dotted Mongo path would read as nesting -- still
// finds its own vouchers and nobody else's.
'use strict';
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$exists' in cond && (val !== undefined) !== cond.$exists) return false;
    } else if (Array.isArray(val)) { if (!val.includes(cond)) return false; }
    else if (val !== cond) return false;
  }
  return true;
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) { Object.assign(f, set); return { matchedCount: 1 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { upsertedCount: 1 }; }
    return { matchedCount: 0 };
  }
  async bulkWrite(ops) { for (const o of ops) await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert }); return { upsertedCount: ops.length }; }
  async deleteMany() { return { deletedCount: 0 }; }
  async deleteOne() { return { deletedCount: 0 }; }
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, batchSize() { return this; },
      async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
  }
  // Just enough of the aggregation language for the voucher lookup: the key-list
  // trick it uses to match a ledger name without treating dots as nesting.
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$match) rows = rows.filter((d) => matches(d, st.$match));
      else if (st.$addFields) rows = rows.map((d) => Object.assign({}, d, {
        _k: Object.keys(d.ledgers || {}).concat(Object.keys(d.party_ledgers || {})) }));
      else if (st.$sort) { const k = Object.keys(st.$sort)[0]; rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * st.$sort[k]); }
      else if (st.$limit) rows = rows.slice(0, st.$limit);
      else if (st.$project) rows = rows.map((d) => { const o = {}; for (const k of Object.keys(st.$project)) if (st.$project[k] === 1) o[k] = d[k]; return o; });
    }
    return { async toArray() { return rows; } };
  }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}) { return this.docs.find((x) => matches(x, filter)) || null; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.PORT = '0';
process.env.INGEST_TOKEN = 'tok';
const app = require('./server');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

// A dot in the name on purpose: "A.B. Traders" as a Mongo path would mean
// ledgers -> A -> B. -> Traders, and would match nothing.
const DOTTED = 'A.B. Traders';
let n = 0;
const V = (branch, date, ledgers, party_ledgers, type) => ({
  _id: branch + ':' + (++n), guid: 'g' + n, branch, date, no: 'V' + n,
  type: type || 'Sales', ledgers, party_ledgers,
});

(async () => {
  fakeDb.collection('masters').docs.push({ branch: 'kol',
    ledgers: { 'Sales A/c': 'Sales Accounts', 'Export Sales': 'Sales Accounts', [DOTTED]: 'Sundry Debtors',
      'Other Customer': 'Sundry Debtors', 'CDC Ahmedabad': 'Branch / Divisions', 'HDFC': 'Bank Accounts' },
    groups: { 'Sales Accounts': 'Revenue Account', 'Sundry Debtors': 'Current Assets',
      'Branch / Divisions': 'Capital Account', 'Bank Accounts': 'Current Assets',
      'Current Assets': 'Capital Account', 'Revenue Account': null, 'Capital Account': null } });
  fakeDb.collection('masters').docs.push({ branch: 'ahm',
    ledgers: { 'Sales A/c': 'Sales Accounts' }, groups: { 'Sales Accounts': 'Revenue Account', 'Revenue Account': null } });

  const vs = fakeDb.collection('vouchers').docs;
  vs.push(V('kol', '20240610', { 'Sales A/c': 100 }, { [DOTTED]: -100 }));
  vs.push(V('kol', '20240715', { 'Export Sales': 250 }, { 'Other Customer': -250 }));
  vs.push(V('kol', '20250610', { 'Sales A/c': 400 }, { [DOTTED]: -400 }));
  vs.push(V('ahm', '20240612', { 'Sales A/c': 70 }, { 'Other Customer': -70 }));
  vs.push(V('kol', '20240820', { 'HDFC': -90 }, { [DOTTED]: 90 }, 'Bank Receipt'));
  vs.push(V('kol', '20240905', { 'HDFC': -15 }, { 'CDC Ahmedabad': 15 }, 'Bank Receipt'));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p) => (await fetch(base + p, { method: 'POST' })).json();
  const settle = async () => { for (let i = 0; i < 100; i++) { const d = await get('/api/yoy'); if (!d.running && d.updatedAt) return d; await new Promise((r) => setTimeout(r, 40)); } throw new Error('never settled'); };

  const empty = await get('/api/yoy/tree?branch=all&line=revenue');
  assert(empty.tree.length === 0, 'before any rebuild the tree is empty rather than an error');

  await post('/api/yoy/scan');
  const sum = await settle();

  const bad = await (await fetch(base + '/api/yoy/tree?line=nonsense')).json();
  assert(/unknown line/.test(bad.error || ''), 'an unknown line is refused by name, not answered with an empty tree');

  const rev = await get('/api/yoy/tree?branch=kol&line=revenue');
  const flat = JSON.stringify(rev.tree);
  assert(rev.fys.join(',') === sum.fys.join(','), 'the tree spans the same years as the summary');
  assert(flat.includes('Sales A/c') && flat.includes('Export Sales'), 'revenue opens down to its ledgers');
  assert(flat.includes('Sales Accounts'), 'nested under their Tally group');

  // Slots run across the years end to end: FY0 April is 0, FY1 April is 12.
  const fi = rev.fys.indexOf('2025-26');
  const sumSlots = (nodes, lo, hi) => { let t = 0; const walk = (ns) => ns.forEach((x) => { for (const k in x.m) if (+k >= lo && +k < hi) t += x.m[k]; if (x.c) walk(x.c); if (x.l) walk(x.l); }); walk(nodes); return t; };
  assert(sumSlots(rev.tree, fi * 12, fi * 12 + 12) === 400 * 2,
    'each year reads its own twelve slots (groups and their ledgers both counted)');

  const cashAll = await get('/api/yoy/tree?branch=all&line=cashIn');
  assert(!JSON.stringify(cashAll.tree).includes('CDC Ahmedabad'),
    'consolidated eliminates the inter-branch account from the cash tree too');
  const cashKol = await get('/api/yoy/tree?branch=kol&line=cashIn');
  assert(JSON.stringify(cashKol.tree).includes('CDC Ahmedabad'), 'while the branch view keeps it');

  // A one-year rebuild must not wipe the other year's detail.
  vs.push(V('kol', '20250715', { 'Sales A/c': 33 }, { 'Other Customer': -33 }));
  await post('/api/yoy/scan?fy=2025-26');
  await settle();
  const rev2 = await get('/api/yoy/tree?branch=kol&line=revenue');
  const i0 = rev2.fys.indexOf('2024-25'), i1 = rev2.fys.indexOf('2025-26');
  assert(sumSlots(rev2.tree, i0 * 12, i0 * 12 + 12) === 350 * 2, 'the year outside the rebuild keeps its detail');
  assert(sumSlots(rev2.tree, i1 * 12, i1 * 12 + 12) === 433 * 2, 'and the rebuilt year picks up the new voucher');

  // ---- vouchers behind one account -------------------------------------------
  const need = await (await fetch(base + '/api/yoy/vouchers?ledger=X')).json();
  assert(/from and to/.test(need.error || ''), 'a voucher lookup without a period is refused');

  const dv = await get('/api/yoy/vouchers?branch=kol&ledger=' + encodeURIComponent(DOTTED) + '&from=20240401&to=20250331');
  assert(dv.count === 2, 'a ledger name containing dots finds its own vouchers');
  assert(dv.vouchers.every((v) => v.date >= '20240401' && v.date <= '20250331'), 'and only those in the period');
  assert(dv.vouchers.map((v) => v.amount).sort((a, b) => a - b).join(',') === '-100,90',
    'each row carries the amount THIS account took on that voucher, whichever side it was booked');
  const other = await get('/api/yoy/vouchers?branch=kol&ledger=Other%20Customer&from=20240401&to=20250331');
  assert(other.count === 1 && other.vouchers[0].no !== dv.vouchers[0].no, 'a different account gets different vouchers');

  const both = await get('/api/yoy/vouchers?branch=all&ledger=Sales%20A%2FC&from=20240401&to=20250331');
  assert(both.count === 0, 'the lookup is case-sensitive, like the ledger names themselves');
  const sales = await get('/api/yoy/vouchers?branch=all&ledger=Sales%20A%2Fc&from=20240401&to=20250331');
  assert(sales.count === 2 && sales.vouchers.some((v) => v.branch === 'ahm'),
    'consolidated reaches both branches');

  const cap = await get('/api/yoy/vouchers?branch=kol&ledger=' + encodeURIComponent(DOTTED) + '&from=20240401&to=20250331&limit=1');
  assert(cap.count === 1 && cap.truncated === true, 'a long list is capped and says so');

  server.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\n== year-on-year drill-down API passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
