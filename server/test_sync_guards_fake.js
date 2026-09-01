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

const { ingest, syncIncremental } = require('./ingest');

// Guards against the two ways an incremental sync can DELETE data it should not.
// Both were live: a week of May 2026 vanished because the extractor was pointed at a
// Tally that did not have the company loaded, so the days were emptied and nothing
// came back to replace them.
let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const V = (guid, date) => ({ guid, date, type: 'Sales', no: guid, ledgers: { Sales: 100 }, party_ledgers: { Party: -100 } });
const count = (q) => fakeDb.collection('vouchers').docs.filter((d) => {
  for (const k of Object.keys(q)) if (d[k] !== q[k]) return false;
  return true;
}).length;

(async () => {
  const D1 = '20260511', D2 = '20260512', D3 = '20260513';
  await ingest({ branch: 'ahm', master: { ledgers: {}, groups: {} }, vouchers: [
    V('a1', D1), V('a2', D1), V('a3', D2), V('a4', D2), V('a5', D3)] });
  assert(count({ branch: 'ahm' }) === 5, 'five vouchers stored across three days');

  // --- 1. A changed date whose replacement is empty -------------------------
  // The pull found nothing for D1 and D2 (wrong Tally). Those days must survive.
  let r = await syncIncremental({ branch: 'ahm', changedDates: [D1, D2, D3],
    vouchers: [V('a5', D3)], lastAlterId: 10 });
  console.log('  sync ->', JSON.stringify(r));
  assert(count({ branch: 'ahm', date: D1 }) === 2, 'a day whose replacement was empty is NOT emptied');
  assert(count({ branch: 'ahm', date: D2 }) === 2, 'nor is the next one');
  assert(count({ branch: 'ahm', date: D3 }) === 1, 'the day that DID come back is replaced normally');
  assert(r.skippedEmptyDates === 2 && r.skippedEmptyHeld === 4, 'the skip is reported with what it protected');
  assert(/came back empty/.test(r.warning || ''), 'and warned about: ' + (r.warning || '(none)'));

  // A day that is genuinely empty on both sides is not worth a warning.
  r = await syncIncremental({ branch: 'ahm', changedDates: ['20260601'], vouchers: [], lastAlterId: 11 });
  assert(r.skippedEmptyDates === 1 && r.skippedEmptyHeld === 0 && !r.warning,
    'a changed date with nothing on either side passes quietly');

  // --- 2. A reconcile carrying another company's guids ----------------------
  for (let i = 0; i < 60; i++) fakeDb.collection('vouchers').docs.push(
    Object.assign({ _id: 'ahm:b' + i, branch: 'ahm' }, V('b' + i, '20260520')));
  const before = count({ branch: 'ahm' });
  r = await syncIncremental({ branch: 'ahm', changedDates: [], vouchers: [],
    currentGuids: ['kol-1', 'kol-2', 'kol-3'], reconcile: true,
    scanFrom: '20260401', scanTo: '20260630', lastAlterId: 12 });
  console.log('  reconcile ->', JSON.stringify(r));
  assert(r.reconcileRefused === true, 'a guid list from the wrong company is refused');
  assert(r.deletedMissing === 0 && count({ branch: 'ahm' }) === before, 'and nothing is deleted');
  assert(/only 0%/.test(r.warning || ''), 'the warning states the overlap: ' + (r.warning || '(none)'));

  // A genuine reconcile still works: Tally lists all but one, that one goes.
  const ours = fakeDb.collection('vouchers').docs
    .filter((d) => d.branch === 'ahm' && d.date >= '20260401' && d.date <= '20260630')
    .map((d) => d.guid);
  const keep = ours.filter((g) => g !== 'b7');
  r = await syncIncremental({ branch: 'ahm', changedDates: [], vouchers: [],
    currentGuids: keep, reconcile: true, scanFrom: '20260401', scanTo: '20260630', lastAlterId: 13 });
  assert(!r.reconcileRefused, 'a list that matches what is stored is not refused');
  assert(r.deletedMissing === 1, 'and the one voucher Tally really dropped is removed');
  assert(count({ branch: 'ahm', date: '20260520' }) === 59, 'exactly one gone, the rest untouched');

  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== sync delete guards passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
