// Tests the ALTERID incremental sync logic against a stubbed Mongo (no DB needed).
// Scenario: seed 3 vouchers, then simulate one EDIT, one BACKDATED new entry, and
// one DELETION, and verify the sync reflects all three + advances the alterId.
const http = require('http');

// ---- extended Mongo stub (adds deleteMany + $in/$nin) ----------------------
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
function project(doc, p) {
  if (!p) return { ...doc };
  const inc = Object.entries(p).some(([k, v]) => v === 1 && k !== '_id');
  const out = {};
  if (inc) { for (const [k, v] of Object.entries(p)) if (v === 1) out[k] = doc[k]; if (p._id !== 0) out._id = doc._id; }
  else { for (const [k, v] of Object.entries(doc)) if (p[k] !== 0) out[k] = v; }
  return out;
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
  find(filter = {}, opts = {}) { const arr = this.docs.filter((d) => matches(d, filter)).map((d) => project(d, opts.projection)); return { sort() { return this; }, limit() { return this; }, async toArray() { return arr; } }; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async findOne(filter = {}, opts = {}) { const d = this.docs.find((x) => matches(x, filter)); return d ? project(d, opts.projection) : null; }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

const { ingest, diffMeta, syncIncremental, getSyncState, voucherKey } = require('./ingest');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const V = (guid, date, amt) => ({ guid, date, type: 'Purchase', no: guid, ledgers: { Exp: amt }, party_ledgers: { Party: -amt } });

(async () => {
  // Seed: old Z on 20250401 (prior FY), A/B on D1, C/D on D2.
  const OLD = '20250401', D1 = '20260610', D2 = '20260620';
  await ingest({ branch: 'ahm', master: { ledgers: {}, groups: {} }, vouchers: [V('gZ', OLD, 50), V('gA', D1, 100), V('gB', D1, 200), V('gC', D2, 300), V('gD', D2, 400)] });
  await fakeDb.collection('sync_state').updateOne({ branch: 'ahm' }, { $set: { branch: 'ahm', lastAlterId: 3 } }, { upsert: true });
  assert((await fakeDb.collection('vouchers').countDocuments({ branch: 'ahm' })) === 5, 'seed = 5 vouchers');

  // Tally's current period only covers 2026-27, so the scan returns D1/D2 vouchers
  // (NOT the prior-FY gZ). Changes: B edited (alter 5), E backdated-added on D1
  // (alter 6), C deleted. D unchanged (alter 2). gZ not scanned at all.
  const meta = [
    { guid: 'gA', date: D1, alterId: 1 },
    { guid: 'gB', date: D1, alterId: 5 },
    { guid: 'gE', date: D1, alterId: 6 },
    { guid: 'gD', date: D2, alterId: 2 },
    // gC absent -> deleted ; gZ (prior FY) not returned by the clamped scan
  ];
  const { changedDates, currentGuids, newMaxAlterId } = diffMeta(meta, (await getSyncState('ahm')).lastAlterId);
  console.log('diff:', JSON.stringify({ changedDates, currentGuids, newMaxAlterId }));
  assert(changedDates.length === 1 && changedDates[0] === D1, 'only D1 flagged changed');
  assert(newMaxAlterId === 6, 'new high-water alterId = 6');
  const scanFrom = meta.reduce((a, m) => (m.date < a ? m.date : a), meta[0].date);
  const scanTo = meta.reduce((a, m) => (m.date > a ? m.date : a), meta[0].date);

  // Extractor re-pulls D1 fresh: A unchanged, B edited to 250, E new.
  const freshD1 = [V('gA', D1, 100), V('gB', D1, 250), V('gE', D1, 500)];
  const r = await syncIncremental({ branch: 'ahm', changedDates, vouchers: freshD1, currentGuids, scanFrom, scanTo, reconcile: true, lastAlterId: newMaxAlterId });
  console.log('sync result:', JSON.stringify(r));

  const all = await fakeDb.collection('vouchers').find({ branch: 'ahm' }).toArray();
  const byGuid = Object.fromEntries(all.map((d) => [d.guid, d]));
  assert(!byGuid.gC, 'deleted voucher gC removed (deletion reconcile, in-window)');
  assert(byGuid.gE, 'backdated new voucher gE captured');
  assert(byGuid.gB && byGuid.gB.ledgers.Exp === 250, 'edited voucher gB now reflects new amount 250');
  assert(byGuid.gD, 'unchanged same-date voucher gD preserved');
  assert(byGuid.gZ, 'SAFETY: prior-FY gZ (outside scan window) NOT deleted despite absent from scan');
  assert(all.length === 5, 'after sync = 5 (Z, A, B_edited, E, D)');
  assert((await getSyncState('ahm')).lastAlterId === 6, 'sync_state advanced to 6');

  // Idempotency: same sync again changes nothing.
  await syncIncremental({ branch: 'ahm', changedDates, vouchers: freshD1, currentGuids, scanFrom, scanTo, reconcile: true, lastAlterId: newMaxAlterId });
  assert((await fakeDb.collection('vouchers').countDocuments({ branch: 'ahm' })) === 5, 're-running same sync is idempotent');

  // No-change run: empty meta diff -> nothing flagged.
  const d2 = diffMeta(meta, 6);
  assert(d2.changedDates.length === 0 && d2.newMaxAlterId === 6, 'no changes when nothing exceeds high-water');

  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== incremental sync logic passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
