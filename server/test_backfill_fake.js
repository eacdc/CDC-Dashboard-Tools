// Tests the historical back-fill guarantees against a stubbed Mongo (no DB needed).
// Scenario: the live 2025-26 master is in place, then an OLD financial-year company
// (2015-16) is ingested with masterMode 'merge'. The live hierarchy must survive
// intact, old-only ledgers must be ADDED (so 2015 vouchers still classify), and the
// old vouchers must land alongside the current ones without disturbing them.
const assert = require('assert');

// ---- minimal Mongo stub (same shape as test_sync_fake.js) ------------------
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
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) { Object.assign(f, set); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async bulkWrite(ops) {
    let u = 0, m = 0, ma = 0;
    for (const o of ops) {
      const r = await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert });
      u += r.upsertedCount; m += r.modifiedCount; ma += r.matchedCount;
    }
    return { upsertedCount: u, modifiedCount: m, matchedCount: ma };
  }
  async findOne(filter = {}) { return this.docs.find((x) => matches(x, filter)) || null; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

const { ingest, readMaster } = require('./ingest');

// ---- fixtures --------------------------------------------------------------
// Live 2025-26 master: ACME renamed since 2015, ZED opened in 2022.
const liveMaster = {
  ledgers: { 'ACME EXPORTS PVT LTD': 'Sundry Debtors', 'ZED PACKAGING': 'Sundry Debtors', 'HDFC BANK': 'Bank Accounts' },
  groups: { 'Sundry Debtors': 'Current Assets', 'Bank Accounts': 'Current Assets', 'Current Assets': null },
  contacts: { 'ZED PACKAGING': { name: 'Ravi', email: 'ravi@zed.example' } },
  ids: { 'ACME EXPORTS PVT LTD': 'guid-acme', 'ZED PACKAGING': 'guid-zed' },
};
// 2015-16 company: ACME under its old name, OLDCO closed since, and a stale group
// mapping for a ledger that still exists today (must NOT win).
const oldMaster = {
  ledgers: { 'ACME EXPORTS': 'Sundry Debtors', 'OLDCO TRADERS': 'Sundry Debtors', 'HDFC BANK': 'Cash-in-Hand' },
  groups: { 'Sundry Debtors': 'Current Assets', 'Cash-in-Hand': 'Current Assets', 'Current Assets': null },
  contacts: { 'OLDCO TRADERS': { name: 'Old Contact' } },
  ids: { 'ACME EXPORTS': 'guid-old-acme', 'OLDCO TRADERS': 'guid-old-oldco' },
};

async function main() {
  // 1) Live sync lands first (default replace).
  await ingest({
    branch: 'kol', from: '20250401', to: '20260318', master: liveMaster,
    vouchers: [{ guid: 'v-live-1', date: '20250405', type: 'Sales', no: 'S/1', party: 'ZED PACKAGING', ledgers: { Sales: 1000 }, party_ledgers: { 'ZED PACKAGING': -1000 } }],
  });

  // 2) Historical back-fill of 2015-16 with masterMode 'merge'.
  const r = await ingest({
    branch: 'kol', from: '20150401', to: '20160331', master: oldMaster, masterMode: 'merge',
    vouchers: [
      { guid: 'v-old-1', date: '20150610', type: 'Sales', no: 'S/9', party: 'OLDCO TRADERS', ledgers: { Sales: 500 }, party_ledgers: { 'OLDCO TRADERS': -500 },
        bills: [{ ledger: 'OLDCO TRADERS', ref: 'CDC/9/15-16', type: 'New Ref', amount: -500 }] },
      { guid: 'v-old-2', date: '20150720', type: 'Receipt', no: 'R/3', party: 'OLDCO TRADERS', ledgers: { 'HDFC BANK': 500 }, party_ledgers: { 'OLDCO TRADERS': 500 },
        alterId: 12, bills: [{ ledger: 'OLDCO TRADERS', ref: 'CDC/9/15-16', type: 'Agst Ref', amount: 500 }] },
    ],
  });
  assert.strictEqual(r.masterMode, 'merge', 'merge mode should be reported back');

  const doc = await fakeDb.collection('masters').findOne({ branch: 'kol' });
  const m = readMaster(doc);

  // The live snapshot fields must be byte-for-byte what the live sync wrote.
  assert.deepStrictEqual(doc.ledgers, liveMaster.ledgers, 'a back-fill must not touch the live ledger snapshot');
  assert.deepStrictEqual(doc.groups, liveMaster.groups, 'a back-fill must not touch the live group snapshot');
  assert.deepStrictEqual(doc.ids, liveMaster.ids, 'old company GUIDs must not leak into ids');
  // ...and the old-only names go to the historical side, never shadowing a live one.
  assert.ok(!('HDFC BANK' in doc.histLedgers), 'a ledger the live master defines is not stored historically');
  // A root group's parent is legitimately null — that still counts as "the live
  // master defines it", so it must not be filed as history.
  assert.ok(!('Current Assets' in doc.histGroups), 'a live root group (parent null) is not stored historically');
  assert.deepStrictEqual(Object.keys(doc.histGroups), ['Cash-in-Hand'], 'only genuinely old groups are kept');

  // What the dashboards read is the union, with live winning.
  assert.strictEqual(m.ledgers['HDFC BANK'], 'Bank Accounts', 'live group mapping must win over the old one');
  assert.strictEqual(m.ledgers['ZED PACKAGING'], 'Sundry Debtors', 'a ledger opened after 2015 must not be dropped');
  assert.strictEqual(m.ledgers['ACME EXPORTS PVT LTD'], 'Sundry Debtors', 'the current name must survive');
  // Old-only ledgers must be present, or their vouchers would not classify.
  assert.strictEqual(m.ledgers['OLDCO TRADERS'], 'Sundry Debtors', 'a ledger closed since 2015 must be readable');
  assert.strictEqual(m.ledgers['ACME EXPORTS'], 'Sundry Debtors', 'the old name must sit alongside the new one');
  assert.strictEqual(m.groups['Cash-in-Hand'], 'Current Assets', 'old-only group must be readable');
  assert.strictEqual(Object.keys(m.ledgers).length, 5, 'exactly the union of both ledger sets');
  assert.strictEqual(m.contacts['ZED PACKAGING'].name, 'Ravi', 'live contact preserved');
  assert.strictEqual(m.contacts['OLDCO TRADERS'].name, 'Old Contact', 'old-only contact readable');

  // Vouchers: both eras coexist, and the old ones kept their bill allocations.
  const vc = fakeDb.collection('vouchers');
  assert.strictEqual(await vc.countDocuments({ branch: 'kol' }), 3, 'old vouchers added, live one kept');
  const old1 = await vc.findOne({ _id: 'kol:v-old-1' });
  assert.strictEqual(old1.bills[0].ref, 'CDC/9/15-16', 'bill-wise refs survive the back-fill');
  assert.strictEqual(old1.bills[0].type, 'New Ref');
  const live = await vc.findOne({ _id: 'kol:v-live-1' });
  assert.strictEqual(live.date, '20250405', 'live voucher untouched');

  // The back-fill must never touch the incremental high-water mark, or the next
  // daily sync would think it had already seen everything.
  assert.strictEqual(await fakeDb.collection('sync_state').countDocuments({}), 0, 'back-fill must not write sync_state');

  // 3) The next day's ordinary live sync must NOT undo the back-fill. This is the
  //    whole reason the historical names live in their own fields.
  await ingest({ branch: 'kol', master: liveMaster, vouchers: [] });
  const m2 = readMaster(await fakeDb.collection('masters').findOne({ branch: 'kol' }));
  assert.strictEqual(m2.ledgers['OLDCO TRADERS'], 'Sundry Debtors', 'a later live sync must not wipe back-filled ledgers');
  assert.strictEqual(m2.ledgers['HDFC BANK'], 'Bank Accounts', 'live mapping still wins after the live sync');

  // 4) A second back-fill (another old year) accumulates instead of replacing.
  await ingest({
    branch: 'kol', masterMode: 'merge', vouchers: [],
    master: { ledgers: { 'ANCIENT CO': 'Sundry Creditors' }, groups: { 'Sundry Creditors': 'Current Liabilities' } },
  });
  const m3 = readMaster(await fakeDb.collection('masters').findOne({ branch: 'kol' }));
  assert.strictEqual(m3.ledgers['ANCIENT CO'], 'Sundry Creditors', 'second back-fill adds its own ledgers');
  assert.strictEqual(m3.ledgers['OLDCO TRADERS'], 'Sundry Debtors', 'and keeps the first back-fill\'s');

  // 5) readMaster on a branch that was never synced stays null (no master, no hierarchy).
  assert.strictEqual(readMaster(null), null, 'no master doc -> no hierarchy');

  console.log('test_backfill_fake: all assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
