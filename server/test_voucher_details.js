// Focused logic test for the voucher `details` round-trip (no real MongoDB).
// Uses the same faithful driver stub as test_e2e_fake.js so ingest.js + server.js
// run unmodified. Verifies: details are persisted on ingest, /api/dataset strips
// them (dashboards stay lean), and /api/voucher returns the full detail.
const http = require('http');

// ---- tiny faithful Mongo stub (mirrors test_e2e_fake.js) -------------------
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    if (k === '$or') { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    const val = doc[k];
    if (cond && typeof cond === 'object' && ('$gte' in cond || '$lte' in cond || '$in' in cond || '$nin' in cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$nin' in cond && cond.$nin.includes(val)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
function project(doc, projection) {
  if (!projection) return { ...doc };
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (projection[k] !== 0) out[k] = v;
  return out;
}
function makeCursor(docs) {
  let arr = docs.map((d) => ({ ...d }));
  const cur = { sort() { return cur; }, limit(n) { arr = arr.slice(0, n); return cur; }, async toArray() { return arr; } };
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
    for (const op of ops) { const r = await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert }); up += r.upsertedCount; mod += r.modifiedCount; mat += r.matchedCount; }
    return { upsertedCount: up, modifiedCount: mod, matchedCount: mat };
  }
  find(filter = {}, opts = {}) { return makeCursor(this.docs.filter((d) => matches(d, filter)).map((d) => project(d, opts.projection))); }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}, opts = {}) { const d = this.docs.find((x) => matches(x, filter)); return d ? project(d, opts.projection) : null; }
}
const fakeDb = { _cols: {}, collection(n) { return (this._cols[n] ||= new FakeCollection()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'cdc_test' } };

function get(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej);
  });
}

(async () => {
  const { ingest } = require('./ingest');
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

  const master = {
    ledgers: { Sale: 'Sales Accounts' }, groups: { 'Sales Accounts': null },
    // Contact person/email/mobile live on the party's Ledger master, not the voucher.
    contacts: {
      'Aakriti Art Gallery Pvt Ltd': { name: 'Vikram Bachawat', email: 'aakritiartgallery@yahoo.com', mobile: '9830411111' },
      Junk: 'should be dropped', Blank: { name: '' },
    },
  };
  const invoice = {
    guid: 'g-inv-1', date: '20260715', no: 'CDC/2662/26-27', type: 'Sales', party: 'Aakriti Art Gallery Pvt Ltd',
    ledgers: { Sale: 137800, 'Output CGST': 12402, 'Output SGST': 12402 },
    party_ledgers: { 'Aakriti Art Gallery Pvt Ltd': -162604 },
    details: {
      partyGstin: '19AAICA7555R1ZQ', ewayBillNo: '811714091343', narration: '',
      deliveryNote: '2678', buyersOrderNo: 'Qtn. No. 6645.2, Qtn. No. 6720.1', buyersOrderDate: '20260713, 20260713',
      partyAddress: ['Orbit Enclave, 1st Floor', '12/3A, Hungerford Street', ''],
      badField: 'should be dropped',
      items: [{ slNo: 1, description: 'OTHER PRINTED MATERIALS HSN 49119990 GST 18%\nMagazine Art Insights\nBatch : Primary Batch', hsn: '49119990', qty: '200', unit: 'Pcs = 200.000 Kgs', rate: '655.00/Pcs', amount: 131000, junk: 'x' }],
    },
  };
  const journal = {
    guid: 'g-jrnl-1', date: '20260630', no: '443', type: 'Journal', party: 'Employees - Salary',
    ledgers: { 'Employees - Salary': -3344694, 'Salary Payable': 2854491 }, party_ledgers: {},
    // no details at all
  };

  await ingest({ branch: 'kol', from: '20260601', to: '20260731', master, vouchers: [invoice, journal] });

  // Stored doc keeps details (invoice) / omits it (journal).
  const storedInv = fakeDb.collection('vouchers').docs.find((d) => d.no === 'CDC/2662/26-27');
  const storedJrnl = fakeDb.collection('vouchers').docs.find((d) => d.no === '443');
  assert(storedInv.details && storedInv.details.partyGstin === '19AAICA7555R1ZQ', 'invoice details persisted');
  assert(storedInv.details.deliveryNote === '2678', 'delivery note persisted');
  assert(storedInv.details.buyersOrderNo === 'Qtn. No. 6645.2, Qtn. No. 6720.1', 'buyer order no persisted');
  assert(storedInv.details.buyersOrderDate === '20260713, 20260713', 'buyer order date (paired) persisted');
  assert(!('badField' in storedInv.details), 'unknown detail field dropped by sanitizer');
  assert(!('junk' in storedInv.details.items[0]), 'unknown item field dropped by sanitizer');

  // Master contacts persisted + sanitised (party contact block source).
  const storedMaster = fakeDb.collection('masters').docs.find((d) => d.branch === 'kol');
  assert(storedMaster.contacts && storedMaster.contacts['Aakriti Art Gallery Pvt Ltd'].name === 'Vikram Bachawat', 'master contacts persisted');
  assert(!('Junk' in storedMaster.contacts), 'non-object contact entry dropped');
  assert(!('Blank' in storedMaster.contacts), 'empty contact entry dropped');
  assert(!('contactName' in storedInv.details), 'contact NOT stored on the voucher (comes from master)');
  assert(storedInv.details.partyAddress.length === 2, 'blank address lines filtered');
  assert(typeof storedInv.details.items[0].amount === 'number', 'item amount coerced to number');
  assert(!('details' in storedJrnl), 'bare journal stores no details key');

  const app = require('./server');
  const server = app.listen(0); await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  // /api/dataset must NOT leak details (keeps dashboard payload lean).
  const ds = (await get(port, '/api/dataset?from=20260601&to=20260731&branch=kol')).body.branches.kol.vouchers;
  assert(ds.length === 2, 'dataset returns both vouchers');
  assert(ds.every((v) => !('details' in v)), 'dataset strips details from every voucher');
  assert(ds.every((v) => v.ledgers !== undefined), 'dataset keeps ledger amounts');
  // guid is retained so the drill-down can link each row to the exact voucher
  // (Tally reuses voucher numbers across FYs — no+date alone is ambiguous).
  assert(ds.every((v) => v.guid !== undefined), 'dataset keeps guid for the voucher link');
  const jrnlDs = ds.find((v) => v.no === '443');
  assert(jrnlDs && jrnlDs.guid === 'g-jrnl-1', 'dataset guid matches the stored voucher');

  // /api/voucher returns full detail.
  const one = (await get(port, '/api/voucher?branch=kol&no=CDC%2F2662%2F26-27')).body;
  assert(one.details && one.details.ewayBillNo === '811714091343', 'voucher endpoint returns details');
  assert(one.details.items && one.details.items[0].hsn === '49119990', 'voucher endpoint returns line items');
  // Contact block enriched from the party's master contact at request time.
  assert(one.details.contactName === 'Vikram Bachawat', 'voucher endpoint enriches contact name from master');
  assert(one.details.contactEmail === 'aakritiartgallery@yahoo.com', 'voucher endpoint enriches contact email from master');
  assert(one.details.contactMobile === '9830411111', 'voucher endpoint enriches contact mobile from master');

  const byId = (await get(port, '/api/voucher?branch=kol&id=g-inv-1')).body;
  assert(byId.no === 'CDC/2662/26-27', 'voucher endpoint resolves by guid');

  const missing = await get(port, '/api/voucher?branch=kol&no=NOPE');
  assert(missing.status === 404, 'missing voucher -> 404');

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== all voucher-details checks passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
