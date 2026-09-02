// Tests /api/meta: the whole-collection numbers stay as they were, and the new
// window/byMonth/byDay views count only what falls inside the asked-for range.
// Those views exist to answer one operational question -- did a pull actually land
// on these dates -- so a month or day that reads 0 has to be visible as 0.
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
  async deleteMany() { return { deletedCount: 0 }; }
  find(filter = {}) {
    let arr = this.docs.filter((d) => matches(d, filter));
    const api = {
      sort(s) { const k = Object.keys(s)[0], dir = s[k]; arr = arr.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir); return api; },
      limit(n) { arr = arr.slice(0, n); return api; },
      batchSize() { return api; },
      async toArray() { return arr; },
    };
    return api;
  }
  // Enough of the aggregation language for the meta breakdown: $match, $group by a
  // field or a $substrBytes prefix of one, $sort by _id.
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$match) rows = rows.filter((d) => matches(d, st.$match));
      else if (st.$group) {
        const spec = st.$group._id;
        const keyOf = (d) => (typeof spec === 'string')
          ? d[spec.slice(1)]
          : String(d[spec.$substrBytes[0].slice(1)]).substr(spec.$substrBytes[1], spec.$substrBytes[2]);
        const bag = new Map();
        for (const d of rows) { const k = keyOf(d); bag.set(k, (bag.get(k) || 0) + 1); }
        rows = [...bag].map(([_id, n]) => ({ _id, n }));
      } else if (st.$sort) {
        const k = Object.keys(st.$sort)[0], dir = st.$sort[k];
        rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * dir);
      }
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

let n = 0;
const V = (branch, date) => ({ _id: branch + ':' + (++n), branch, date, type: 'Sales', ledgers: {}, party_ledgers: {} });

(async () => {
  const vs = fakeDb.collection('vouchers').docs;
  // kol: two before the window, three in April 2025, two in June 2025 -- May left empty
  // on purpose, because an empty month is exactly what these views must reveal.
  vs.push(V('kol', '20240115'), V('kol', '20250331'));
  vs.push(V('kol', '20250401'), V('kol', '20250401'), V('kol', '20250415'));
  vs.push(V('kol', '20250610'), V('kol', '20250612'));
  vs.push(V('ahm', '20250405'), V('ahm', '20250520'), V('ahm', '20241101'));
  fakeDb.collection('masters').docs.push({ branch: 'kol', updatedAt: 'X' });

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();

  const plain = await get('/api/meta');
  assert(plain.kol.vouchers === 7 && plain.ahm.vouchers === 3, 'without a range the counts are the whole collection');
  assert(plain.kol.firstDate === '20240115' && plain.kol.lastDate === '20250612', 'and the full first/last dates');
  assert(plain.kol.window === undefined, 'no window block unless a range is asked for');

  const w = await get('/api/meta?from=20250401');
  assert(w.kol.vouchers === 7, 'the whole-collection count is still reported alongside');
  assert(w.kol.window.vouchers === 5, 'the window counts only from April 2025 -- the two earlier ones drop out');
  assert(w.kol.window.firstDate === '20250401' && w.kol.window.lastDate === '20250612', 'window first/last are the window\'s own');
  assert(w.ahm.window.vouchers === 2, 'and it is applied per branch');

  const wt = await get('/api/meta?from=20250401&to=20250430');
  assert(wt.kol.window.vouchers === 3 && wt.kol.window.to === '20250430', 'an upper bound narrows it too');

  const m = await get('/api/meta?from=20250401&byMonth=1');
  assert(m.kol.months['202504'] === 3 && m.kol.months['202506'] === 2, 'byMonth totals each month in the window');
  assert(m.kol.months['202503'] === undefined, 'months before the window are not in the breakdown');
  assert(m.kol.months['202505'] === undefined, 'a month with nothing stored is absent -- that absence IS the gap');

  const d = await get('/api/meta?from=20250401&to=20250430&byDay=1');
  assert(d.kol.days['20250401'] === 2 && d.kol.days['20250415'] === 1, 'byDay totals each date');
  assert(Object.keys(d.kol.days).length === 2, 'and lists only dates that actually hold vouchers');

  const bad = await get('/api/meta?from=2025-04-01');
  assert(bad.kol.window === undefined, 'a malformed date is ignored rather than silently matching nothing');

  server.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\n== meta api passed ==');
  process.exit(fails ? 1 : 0);
})();
