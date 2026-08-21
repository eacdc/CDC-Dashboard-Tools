// Tests branch reset against a stubbed Mongo (no DB needed).
//
// Scenario is the real accident: the Ahmedabad company was pulled with -Branch kol,
// so Ahmedabad's vouchers landed in "kol" alongside Kolkata's own, and kol's ledger
// master was replaced by Ahmedabad's. Because the two companies' vouchers have
// different GUIDs, keys never collide -- a plain re-push does NOT undo it. Only the
// reset does, and this verifies exactly that, over HTTP through /admin/reset.
const http = require('http');

// ---- Mongo stub (same shape as test_sync_fake, plus deleteOne) --------------
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$nin' in cond && cond.$nin.includes(val)) return false;
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
  async bulkWrite(ops) { let u = 0, m = 0, ma = 0; for (const o of ops) { const r = await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert }); u += r.upsertedCount; m += r.modifiedCount; ma += r.matchedCount; } return { upsertedCount: u, modifiedCount: m, matchedCount: ma }; }
  async deleteMany(filter) { const before = this.docs.length; this.docs = this.docs.filter((d) => !matches(d, filter)); return { deletedCount: before - this.docs.length }; }
  async deleteOne(filter) { const i = this.docs.findIndex((d) => matches(d, filter)); if (i < 0) return { deletedCount: 0 }; this.docs.splice(i, 1); return { deletedCount: 1 }; }
  find(filter = {}) { const arr = this.docs.filter((d) => matches(d, filter)); return { sort() { return this; }, limit() { return this; }, async toArray() { return arr; } }; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}) { return this.docs.find((x) => matches(x, filter)) || null; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.INGEST_TOKEN = 'test-token';
process.env.PORT = '0';
const app = require('./server');
const { ingest, resetBranch } = require('./ingest');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const V = (guid, date) => ({ guid, date, type: 'Sales', no: guid, ledgers: { Sales: 100 }, party_ledgers: { Party: -100 } });
const vouchers = (branch) => fakeDb.collection('vouchers').docs.filter((d) => d.branch === branch);

function post(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ port, path, method: 'POST', headers: Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      token ? { 'x-ingest-token': token } : {}) },
      (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}') })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  const FROM = '20250401', TO = '20260820';
  // Kolkata's own data, correctly ingested.
  await ingest({ branch: 'kol', from: FROM, to: TO, master: { ledgers: { 'Kol Party': 'Sundry Debtors' }, groups: { 'Sundry Debtors': null } },
    vouchers: [V('kol-1', '20250501'), V('kol-2', '20260101')] });
  // A back-filled prior year, outside the range that will be reset.
  await ingest({ branch: 'kol', from: '20240401', to: '20250331', vouchers: [V('kol-old', '20240701')] });
  // THE ACCIDENT: the Ahmedabad company pulled with -Branch kol.
  await ingest({ branch: 'kol', from: FROM, to: TO, master: { ledgers: { 'Ahm Party': 'Sundry Debtors' }, groups: { 'Sundry Debtors': null } },
    vouchers: [V('ahm-1', '20250501'), V('ahm-2', '20260101')] });
  await fakeDb.collection('sync_state').updateOne({ branch: 'kol' }, { $set: { branch: 'kol', lastAlterId: 999 } }, { upsert: true });

  assert(vouchers('kol').length === 5, 'accident leaves BOTH companies in kol (2 kol + 1 old + 2 ahm)');
  assert((await fakeDb.collection('masters').findOne({ branch: 'kol' })).ledgers['Ahm Party'] !== undefined,
    "accident also replaced kol's ledger master with Ahmedabad's");

  // A plain re-push of the correct data does NOT clean it: different GUIDs, no collision.
  await ingest({ branch: 'kol', from: FROM, to: TO, vouchers: [V('kol-1', '20250501'), V('kol-2', '20260101')] });
  assert(vouchers('kol').length === 5, 'plain re-push does NOT remove the foreign vouchers (why reset exists)');

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  // Auth and scope are enforced.
  assert((await post(port, '/admin/reset', { branch: 'kol', all: true }, 'wrong')).status === 401, 'reset rejects a bad token');
  assert((await post(port, '/admin/reset', { branch: 'xxx', all: true }, 'test-token')).status === 400, 'reset rejects an unknown branch');
  const noScope = await post(port, '/admin/reset', { branch: 'kol' }, 'test-token');
  assert(noScope.status === 400 && /from\+to/.test(noScope.body.error), 'reset refuses to run without an explicit scope');
  assert(vouchers('kol').length === 5, 'nothing was deleted by the rejected calls');

  // The fix: reset the range, then re-ingest the right company.
  const r = await post(port, '/admin/reset', { branch: 'kol', from: FROM, to: TO }, 'test-token');
  console.log('reset ->', JSON.stringify(r.body));
  assert(r.status === 200 && r.body.deletedVouchers === 4, 'reset deleted the 4 in-range vouchers (both companies)');
  assert(r.body.masterDeleted === true, 'reset dropped the contaminated master');
  assert(r.body.syncStateCleared === true, 'reset cleared the sync high-water mark');
  assert(vouchers('kol').length === 1 && vouchers('kol')[0].guid === 'kol-old',
    'the back-filled prior year, outside the range, survived');

  await ingest({ branch: 'kol', from: FROM, to: TO, master: { ledgers: { 'Kol Party': 'Sundry Debtors' }, groups: { 'Sundry Debtors': null } },
    vouchers: [V('kol-1', '20250501'), V('kol-2', '20260101')] });
  const after = vouchers('kol').map((d) => d.guid).sort();
  assert(after.join(',') === 'kol-1,kol-2,kol-old', 'after reset + re-ingest kol holds only Kolkata data: ' + after.join(','));
  const master = await fakeDb.collection('masters').findOne({ branch: 'kol' });
  assert(master.ledgers['Kol Party'] && !master.ledgers['Ahm Party'], "kol's master is Kolkata's again, with no trace of Ahmedabad");

  // all:true also takes the back-filled year.
  await resetBranch({ branch: 'kol', all: true });
  assert(vouchers('kol').length === 0, 'all:true clears every date, back-fill included');

  // Other branches are never touched.
  await ingest({ branch: 'ahm', from: FROM, to: TO, vouchers: [V('a-1', '20250501')] });
  await resetBranch({ branch: 'kol', all: true });
  assert(vouchers('ahm').length === 1, 'resetting kol leaves ahm alone');

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== branch reset logic passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
