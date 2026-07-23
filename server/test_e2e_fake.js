// Logic test WITHOUT a real MongoDB (the download host is egress-blocked here).
// A faithful stub of just the driver calls our code makes is injected via the
// require cache, so ingest.js + server.js run byte-for-byte unmodified. This
// verifies: idempotent upsert keying, field cleaning, date-range filtering, and
// projection stripping. The final real-DB check is `node test_e2e.js` against Atlas.
const fs = require('fs');
const http = require('http');
const path = require('path');

// ---- tiny faithful Mongo stub ----------------------------------------------
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = doc[k];
    if (cond && typeof cond === 'object' && ('$gte' in cond || '$lte' in cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
function project(doc, projection) {
  if (!projection) return { ...doc };
  const entries = Object.entries(projection);
  const including = entries.some(([k, v]) => v === 1 && k !== '_id');
  const out = {};
  if (including) {
    for (const [k, v] of entries) if (v === 1) out[k] = doc[k];
    if (projection._id !== 0) out._id = doc._id;
  } else {
    for (const [k, v] of Object.entries(doc)) if (projection[k] !== 0) out[k] = v;
  }
  return out;
}
function makeCursor(docs) {
  let arr = docs.map((d) => ({ ...d }));
  const cur = {
    sort(spec) { const [k, dir] = Object.entries(spec)[0]; arr.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir); return cur; },
    limit(n) { arr = arr.slice(0, n); return cur; },
    async toArray() { return arr; },
  };
  return cur;
}
class FakeCollection {
  constructor() { this.docs = []; }
  async createIndex() {}
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const found = this.docs.find((d) => matches(d, filter));
    if (found) { Object.assign(found, set); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async bulkWrite(ops) {
    let up = 0, mod = 0, mat = 0;
    for (const op of ops) {
      const { filter, update, upsert } = op.updateOne;
      const r = await this.updateOne(filter, update, { upsert });
      up += r.upsertedCount; mod += r.modifiedCount; mat += r.matchedCount;
    }
    return { upsertedCount: up, modifiedCount: mod, matchedCount: mat };
  }
  find(filter = {}, opts = {}) { return makeCursor(this.docs.filter((d) => matches(d, filter)).map((d) => project(d, opts.projection))); }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}, opts = {}) { const d = this.docs.find((x) => matches(x, filter)); return d ? project(d, opts.projection) : null; }
}
const fakeDb = { _cols: {}, collection(n) { return (this._cols[n] ||= new FakeCollection()); } };

// inject the fake db module before ingest/server require it
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'cdc_test' } };

// ---- run the same assertions as the real e2e -------------------------------
function get(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej);
  });
}
(async () => {
  const MASTER = process.argv[2], TXNS = process.argv[3];
  const master = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
  const vouchers = JSON.parse(fs.readFileSync(TXNS, 'utf8'));
  const { ingest, voucherKey } = require('./ingest');
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

  console.log(`\n== ingest ${vouchers.length} vouchers x2 (branch=ahm) ==`);
  await ingest({ branch: 'ahm', from: '20250401', to: '20260716', master, vouchers });
  await ingest({ branch: 'ahm', from: '20250401', to: '20260716', master, vouchers });
  const dbCount = await fakeDb.collection('vouchers').countDocuments({ branch: 'ahm' });
  const uniqKeys = new Set(vouchers.map((v) => voucherKey('ahm', v))).size;
  console.log(`db count after 2x ingest = ${dbCount} (source ${vouchers.length}, unique keys ${uniqKeys})`);
  assert(dbCount === uniqKeys, 'idempotent: re-ingest does not duplicate');
  assert(uniqKeys === vouchers.length, 'content-hash fallback preserves the two same-(date,type,no) Champion vouchers (no data loss)');

  const app = require('./server');
  const server = app.listen(0); await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const full = (await get(port, '/api/dataset?from=20250401&to=20260716&branch=ahm')).body.branches.ahm;
  console.log(`full-FY: ledgers=${Object.keys(full.hierarchy.ledgers).length} groups=${Object.keys(full.hierarchy.groups).length} vouchers=${full.vouchers.length}`);
  assert(Object.keys(full.hierarchy.ledgers).length > 700, 'hierarchy ledgers returned');
  assert(full.vouchers.length === vouchers.length, 'all vouchers for full range');
  const s = full.vouchers[0];
  assert(s.date && s.type && s.ledgers !== undefined && s.party_ledgers !== undefined, 'voucher shape intact');
  assert(s._id === undefined && s.branch === undefined && s.updatedAt === undefined, 'internal fields stripped');
  assert(s.guid !== undefined, 'guid retained for the drill-down voucher link');

  const apr = (await get(port, '/api/dataset?from=20250401&to=20250430&branch=ahm')).body.branches.ahm.vouchers;
  console.log(`Apr-2025 only: ${apr.length}`);
  assert(apr.length > 0 && apr.length < vouchers.length, 'date range narrows');
  assert(apr.every((v) => v.date >= '20250401' && v.date <= '20250430'), 'no leakage outside range');

  const def = (await get(port, '/api/dataset?branch=ahm')).body;
  console.log(`default range: ${def.from}..${def.to} vouchers=${def.branches.ahm.vouchers.length}`);
  assert(def.from.endsWith('0401'), 'default from = 1-Apr of an FY');

  const meta = (await get(port, '/api/meta')).body.ahm;
  console.log('meta.ahm:', JSON.stringify(meta));
  assert(meta.vouchers === vouchers.length && meta.firstDate && meta.lastDate, 'meta coverage correct');

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== all logic checks passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
