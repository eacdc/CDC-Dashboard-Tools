// Real-MongoDB smoke test. Point it at your Atlas cluster (or any mongod) and it
// ingests the sample into a throwaway DB, exercises the API, then drops the DB.
//
//   MONGODB_URI="mongodb+srv://..." node test_e2e.js <masterPath> <txnsPath>
//
// Uses MONGODB_DB=cdc_e2e_test so it never touches your real "cdc" data.
require('./loadEnv');
process.env.MONGODB_DB = process.env.MONGODB_DB_TEST || 'cdc_e2e_test';
process.env.INGEST_TOKEN = '';
const fs = require('fs');
const http = require('http');

if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI to run this test.'); process.exit(2); }

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
  });
}

(async () => {
  const master = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const vouchers = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const { ingest, voucherKey } = require('./ingest');
  const { getDb, close } = require('./db');
  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

  await ingest({ branch: 'ahm', from: '20250401', to: '20260716', master, vouchers });
  await ingest({ branch: 'ahm', from: '20250401', to: '20260716', master, vouchers });
  const db = await getDb();
  const count = await db.collection('vouchers').countDocuments({ branch: 'ahm' });
  const uniq = new Set(vouchers.map((v) => voucherKey('ahm', v))).size;
  assert(count === uniq, `idempotent upsert (stored ${count} == unique ${uniq})`);

  const app = require('./server');
  const server = app.listen(0); await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const full = (await get(port, '/api/dataset?from=20250401&to=20260716&branch=ahm')).branches.ahm;
  assert(full.vouchers.length === uniq, 'full-range query returns all vouchers');
  assert(Object.keys(full.hierarchy.ledgers).length > 700, 'hierarchy returned');
  const apr = (await get(port, '/api/dataset?from=20250401&to=20250430&branch=ahm')).branches.ahm.vouchers;
  assert(apr.length > 0 && apr.every((v) => v.date <= '20250430'), 'date-range filter works');

  await db.dropDatabase();
  server.close(); await close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== real-DB e2e passed (test DB dropped) ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
