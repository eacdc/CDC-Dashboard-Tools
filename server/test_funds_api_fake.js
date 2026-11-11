// GET /api/funds end to end: the funds-flow statement over a real-shaped fixture.
//
// The arithmetic is pinned in test_funds_fake.js against fundsFlow.js directly. What this
// file is for is the ADAPTER -- which ledgers it decides are trade, where it looks for
// them, and whether the loan and capex halves really come from the same functions the loan
// and capex pages are built on. The interesting mistake lives there: a receivable is a Dr
// and arrives from Tally NEGATIVE, so one missing sign turns what customers owe us into a
// liability and the whole statement inside out.

// Mongo expression and filter support, kept to what this endpoint's pipeline uses.
function valueAt(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
  return cur;
}
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = valueAt(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$ne' in cond && val === cond.$ne) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$gt' in cond && !(val > cond.$gt)) return false;
      if ('$lt' in cond && !(val < cond.$lt)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
function expr(doc, e) {
  if (e === null || typeof e === 'number' || typeof e === 'boolean') return e;
  if (typeof e === 'string') {
    if (e[0] !== '$') return e;
    return valueAt(doc, e.slice(1));
  }
  if (Array.isArray(e)) return e.map((x) => expr(doc, x));
  const op = Object.keys(e)[0], a = e[op];
  if (op === '$ifNull') { const r = expr(doc, a[0]); return (r == null) ? expr(doc, a[1]) : r; }
  if (op === '$objectToArray') { const o = expr(doc, a) || {}; return Object.keys(o).map((k) => ({ k, v: o[k] })); }
  if (op === '$concatArrays') return expr(doc, a).reduce((x, y) => x.concat(y), []);
  if (op === '$cond') return expr(doc, a[0]) ? expr(doc, a[1]) : expr(doc, a[2]);
  if (op === '$gt') { const [x, y] = expr(doc, a); return x > y; }
  if (op === '$lt') { const [x, y] = expr(doc, a); return x < y; }
  if (op === '$multiply') return expr(doc, a).reduce((x, y) => x * y, 1);
  throw new Error('fake aggregate: unsupported operator ' + op);
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async findOne(filter = {}) { return this.docs.find((d) => matches(d, filter)) || null; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, batchSize() { return this; },
      project() { return this; }, async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
  }
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$match) { rows = rows.filter((d) => matches(d, st.$match)); continue; }
      if (st.$project) {
        rows = rows.map((d) => {
          const o = {};
          for (const [k, v] of Object.entries(st.$project)) o[k] = (v === 1) ? d[k] : expr(d, v);
          return o;
        });
        continue;
      }
      if (st.$unwind) {
        const path = String(st.$unwind).replace(/^\$/, ''), next = [];
        for (const d of rows) for (const item of (d[path] || [])) next.push({ ...d, [path]: item });
        rows = next;
        continue;
      }
      if (st.$group) {
        const spec = st.$group, byKey = new Map();
        for (const d of rows) {
          const id = (spec._id && typeof spec._id === 'object')
            ? Object.fromEntries(Object.keys(spec._id).map((k) => [k, expr(d, spec._id[k])]))
            : expr(d, spec._id);
          const key = JSON.stringify(id);
          let acc = byKey.get(key);
          if (!acc) { acc = { _id: id }; byKey.set(key, acc); }
          for (const f of Object.keys(spec)) {
            if (f === '_id') continue;
            const o = Object.keys(spec[f])[0], v = expr(d, spec[f][o]);
            if (o === '$sum') acc[f] = (acc[f] || 0) + (typeof v === 'number' ? v : 0);
          }
        }
        rows = [...byKey.values()];
        continue;
      }
      throw new Error('fake aggregate: unsupported stage ' + Object.keys(st)[0]);
    }
    return { async toArray() { return rows; } };
  }
}
const fakeDb = { _c: {}, collection(n) { return (this._c[n] ||= new Col()); } };
const dbPath = require.resolve('./db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { getDb: async () => fakeDb, close: async () => {}, DB_NAME: 'test' } };

process.env.PORT = '0';
const app = require('./server');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= 1;
const L = 100000, CR = 10000000;

let n = 0;
const V = (branch, date, pl, ld, extra) => ({
  _id: branch + ':' + (++n), guid: 'g' + n, branch, date, no: 'V' + n, type: 'Journal',
  party_ledgers: pl || {}, ledgers: ld || {}, ...(extra || {}),
});

(async () => {
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: {
      'Aakriti Art Gallery': 'Commercial - S/Dr',
      'Pinghu Bindex Machinery': 'Sundry Creditor - Paper',
      'CDC Printers (Ahmedabad)': 'Branch / Divisions',  // the other company: not a customer
      'HDFC Term Loan': 'Secured Loans',
      'Advance for Machinery': 'Capital Advances',
      'Plant & Machinery': 'Fixed Assets',
      'Sale - Printing': 'Sales Accounts',
    },
    groups: {
      'Commercial - S/Dr': 'Sundry Debtors', 'Sundry Debtors': 'Current Assets',
      'Branch / Divisions': 'Sundry Debtors',
      'Sundry Creditor - Paper': 'Sundry Creditors', 'Sundry Creditors': 'Current Liabilities',
      'Secured Loans': 'Loans (Liability)', 'Loans (Liability)': 'Capital Account',
      'Capital Advances': 'Current Assets', 'Current Assets': 'Capital Account',
      'Current Liabilities': 'Capital Account', 'Fixed Assets': 'Capital Account',
      'Sales Accounts': 'Revenue Account', 'Capital Account': null, 'Revenue Account': null,
    },
    // Tally-raw on 1 Apr 2026: customers owe 5 Cr (a Dr, so -ve), we owe suppliers 3 Cr
    // (a Cr, +ve), the term loan stands at 10 Cr.
    ids: {},
    opening: { 'Aakriti Art Gallery': -5 * CR, 'Pinghu Bindex Machinery': 3 * CR,
      'HDFC Term Loan': 10 * CR, 'Advance for Machinery': -1 * CR },
    openingAsOn: '20260401',
  });

  const vs = fakeDb.collection('vouchers').docs;
  // The books open on the 2nd: 1 April is a holiday. Touches no trade, loan or asset
  // ledger, so it changes no figure here -- it is the fixture's oldest voucher, nothing more.
  vs.push(V('kol', '20260402', {}, { 'Sale - Printing': 50000, 'Rounding Off': -50000 }));
  // Over the year: customers come to owe 3 Cr more, suppliers 1 Cr more.
  vs.push(V('kol', '20260901', { 'Aakriti Art Gallery': -3 * CR }, { 'Sale - Printing': 3 * CR }));
  vs.push(V('kol', '20261001', { 'Pinghu Bindex Machinery': 1 * CR }, { 'Plant & Machinery': -1 * CR }));
  // 5 Cr borrowed on the term loan.
  vs.push(V('kol', '20260715', {}, { 'HDFC Term Loan': 5 * CR, 'Plant & Machinery': -5 * CR }));
  // A further 50 L paid out in advance for a machine that has not come.
  vs.push(V('kol', '20261101', {}, { 'Advance for Machinery': -50 * L, 'HDFC Term Loan': 50 * L }));
  // Drafts reach no figure on any page, and must not reach this one either.
  vs.push(V('kol', '20261105', { 'Aakriti Art Gallery': -99 * CR }, {}, { cancelled: true }));
  vs.push(V('kol', '20261106', { 'Pinghu Bindex Machinery': 99 * CR }, {}, { optional: true }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await (await fetch(base + p)).json());

  // ---- what it refuses -----------------------------------------------------
  const noDates = await get('/api/funds?branch=kol');
  assert(noDates.ok === false && /from and to/.test(noDates.error || ''),
    'a window is required rather than guessed at');
  const backwards = await get('/api/funds?branch=kol&from=20270331&to=20260401');
  assert(backwards.ok === false && /before/.test(backwards.error || ''),
    'a window that ends before it starts is refused, and said to be');

  // ---- the statement -------------------------------------------------------
  const f = await get('/api/funds?branch=kol&from=20260401&to=20270331');
  assert(f.ok === true, 'a year of trade, borrowing and machines comes back as one statement');

  // THE SIGN. This is the assertion the whole file exists for.
  assert(near(f.opening.receivables, 5 * CR),
    'what customers owe us reads as a POSITIVE 5 Cr, not as the Dr Tally stores');
  assert(near(f.opening.payables, 3 * CR), 'what we owe suppliers reads as a positive 3 Cr');
  assert(near(f.opening.tradeNet, 2 * CR), 'so 2 Cr of funds sat in trade when the year opened');
  assert(near(f.opening.loans, 10 * CR), 'and the borrowing it opened with is the loan page\'s own opening');

  assert(near(f.closing.receivables, 8 * CR), 'a year of invoices carries receivables to 8 Cr');
  assert(near(f.closing.payables, 4 * CR), 'and payables to 4 Cr');
  assert(near(f.change.tradeNet, 2 * CR), 'trade absorbed another 2 Cr over the year');
  assert(near(f.change.loans, 5.5 * CR), 'borrowing rose by 5.5 Cr');

  // The capex half comes from computeCapex, so these are the capex page's own figures.
  assert(near(f.change.capitalised, 6 * CR),
    'the machines capitalised are the capex page\'s own figure, not a second derivation');
  assert(near(f.change.advances, 50 * L), 'and so is the 50 L more paid out against machines not yet here');

  assert(near(f.uses, 8.5 * CR), 'trade, machines and advances absorbed 8.5 Cr between them');
  assert(near(f.sources, 5.5 * CR), 'new borrowing supplied 5.5 Cr of it');
  assert(near(f.residual, 3 * CR), 'and 3 Cr came from outside what this statement tracks');
  assert(f.fundedShare > 64 && f.fundedShare < 65, 'borrowing covered about 65% of what was absorbed');

  // ---- drafts --------------------------------------------------------------
  assert(f.closing.receivables < 50 * CR && f.closing.payables < 50 * CR,
    'a cancelled invoice and an optional one reach neither balance');

  // ---- THE OTHER COMPANY IS NOT A CUSTOMER --------------------------------
  fakeDb.collection('masters').docs.push({
    branch: 'ahm',
    ledgers: { 'CDC Printers (Kolkata)': 'Branch / Divisions', 'Local Buyer': 'Commercial - S/Dr' },
    groups: {
      'Branch / Divisions': 'Sundry Debtors', 'Commercial - S/Dr': 'Sundry Debtors',
      'Sundry Debtors': 'Current Assets', 'Current Assets': 'Capital Account', 'Capital Account': null,
    },
    ids: {}, opening: { 'CDC Printers (Kolkata)': -7 * CR, 'Local Buyer': -1 * CR },
    openingAsOn: '20260401',
  });
  const one = await get('/api/funds?branch=ahm&from=20260401&to=20270331');
  assert(near(one.opening.receivables, 8 * CR),
    'read on its own, a branch really IS owed what the other company owes it');
  const all = await get('/api/funds?branch=all&from=20260401&to=20270331');
  assert(near(all.opening.receivables, 6 * CR),
    'but consolidated drops the inter-branch account: the group is not owed money by itself');
  assert((all.notes || []).some((x) => /inter-branch/i.test(x)),
    'and the page says so, rather than leaving a reader to wonder where 7 Cr went');

  // ---- A WINDOW THAT OPENS BEFORE THE VOUCHERS DO --------------------------
  // The opening is Tally's balance walked backwards posting by posting, so starting
  // earlier than the oldest voucher lands on a balance that is wrong by everything
  // before it -- while every row still adds up, which is what makes it dangerous.
  const early = await get('/api/funds?branch=kol&from=20200401&to=20270331');
  assert(early.ok === true, 'a window reaching back past the data still answers');
  assert((early.notes || []).some((x) => /BEFORE THE VOUCHERS DO/.test(x)),
    'but it SAYS so, rather than quietly showing an opening that is years short');
  assert((early.notes || []).some((x) => /days later/.test(x)),
    'and COUNTS the uncovered stretch, since how wide it is decides whether it matters');
  // A WINDOW OPENING A FEW DAYS BEFORE THE FIRST VOUCHER IS NORMAL -- 1 April is a
  // holiday and the books open a few days in. Shouting about that teaches the reader
  // to skip the warning that matters.
  const sameYear = await get('/api/funds?branch=kol&from=20260401&to=20270331');
  assert(!(sameYear.notes || []).some((x) => /BEFORE THE VOUCHERS DO/.test(x)),
    'a window opening the day before the books do says nothing, because nothing is missing');

  // ---- what it rests on ----------------------------------------------------
  fakeDb.collection('masters').docs.push({
    branch: 'kol2', ledgers: {}, groups: {}, ids: {},
  });
  const noOpen = await get('/api/funds?branch=kol&from=20260401&to=20270331');
  assert(Array.isArray(noOpen.notes), 'the statement always carries its own caveats');
  assert(/stock/i.test(noOpen.excludes || ''),
    'and says on its face that stock is not in it -- a figure nobody trusts is worse than none');

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== funds-flow API passed ==');
  process.exit(fails ? 1 : 0);
})();
