// Tests the year-on-year endpoints against a stubbed Mongo: the background rebuild,
// the cached read, the partial (one-year) rebuild, and the automatic refresh that
// follows an ingest. No DB, no browser -- the figures themselves are checked against
// the real dashboard in test_yoy_fake.js.
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) { Object.assign(f, set); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async bulkWrite(ops) { for (const o of ops) await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert }); return { upsertedCount: ops.length, modifiedCount: 0, matchedCount: 0 }; }
  async deleteMany() { return { deletedCount: 0 }; }
  async deleteOne() { return { deletedCount: 0 }; }
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, batchSize() { return this; },
      async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
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

let n = 0;
const V = (branch, date, sales) => ({
  _id: branch + ':' + (++n), branch, date, type: 'Sales',
  ledgers: { 'Sales A/c': sales }, party_ledgers: { 'A Customer': -sales },
});

function post(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = JSON.stringify(body || {});
    const req = http.request({ port, path, method: 'POST', headers: Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, token ? { 'x-ingest-token': token } : {}) },
      (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}') })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const get = async (base, p) => (await fetch(base + p)).json();
const settle = async (base) => {
  for (let i = 0; i < 100; i++) {
    const d = await get(base, '/api/yoy');
    if (!d.running && d.updatedAt) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the summary never settled');
};

(async () => {
  fakeDb.collection('masters').docs.push({ branch: 'kol',
    ledgers: { 'Sales A/c': 'Sales Accounts', 'A Customer': 'Sundry Debtors' },
    groups: { 'Sales Accounts': 'Revenue Account', 'Sundry Debtors': 'Current Assets', 'Current Assets': 'Capital Account', 'Revenue Account': null, 'Capital Account': null } });
  fakeDb.collection('vouchers').docs.push(
    V('kol', '20230510', 100), V('kol', '20240610', 200), V('kol', '20250710', 300));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;

  const before = await get(base, '/api/yoy');
  assert(before.fys.length === 0 && !before.updatedAt, 'GET answers empty and instantly before any rebuild');

  assert((await post(port, '/api/yoy/scan')).body.started === true, 'POST starts a rebuild and returns at once');
  const full = await settle(base);
  assert(full.fys.join(',') === '2023-24,2024-25,2025-26', 'every financial year present, oldest first');
  assert(full.branches.all['2024-25'].totals.revenue === 200, 'a year total is folded correctly');
  assert(full.branches.all['2025-26'].revenue[3] === 300, 'July lands in month index 3');
  assert(full.scannedVouchers === 3, 'the vouchers it read are reported');

  // A partial rebuild must leave the other years exactly as they were.
  fakeDb.collection('vouchers').docs.push(V('kol', '20240815', 555));
  assert((await post(port, '/api/yoy/scan?fy=2024-25')).body.scope.join(',') === '2024-25', 'a rebuild can be scoped to one year');
  let d = await settle(base);
  assert(d.branches.all['2024-25'].totals.revenue === 755, 'the rebuilt year picks up the new voucher');
  assert(d.branches.all['2023-24'].totals.revenue === 100, 'a year outside the scope is left untouched');
  assert(d.scannedVouchers === 2, 'the partial rebuild read only that year');

  // Ingest should refresh the year it touched, with nobody asking.
  const ing = await post(port, '/ingest', { branch: 'kol', from: '20230401', to: '20240331',
    vouchers: [{ guid: 'x1', date: '20230610', type: 'Sales', no: 'S9', ledgers: { 'Sales A/c': 40 }, party_ledgers: { 'A Customer': -40 } }] }, 'tok');
  assert(ing.status === 200, 'the ingest itself succeeds');
  d = await settle(base);
  assert(d.branches.all['2023-24'].totals.revenue === 140, 'ingest refreshed the year it touched, automatically');
  assert(d.branches.all['2024-25'].totals.revenue === 755, 'and left the other years alone');

  // The date span, not just its endpoints, decides which years are refreshed.
  const wide = await post(port, '/ingest', { branch: 'kol', from: '20230401', to: '20260331', vouchers: [] }, 'tok');
  assert(wide.status === 200, 'a multi-year push is accepted');
  d = await settle(base);
  assert(d.fys.join(',') === '2023-24,2024-25,2025-26', 'a range spanning years rebuilds all of them, not just the ends');

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== year-on-year API passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
