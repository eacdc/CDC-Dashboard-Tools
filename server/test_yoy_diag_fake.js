// The diagnostic: why one party's figure is what it is.
//
// It exists because a real question -- "this customer is in Year on Year and not in
// the date-range view, why?" -- took a conversation and three screenshots to answer,
// and still ended in a guess. So it has to answer the shapes that question actually
// takes, and the fixture below is the real one: a customer carrying THREE ledgers in
// Tally, one of them the payer of an invoice that lands on somebody else.
//
// The explanation must come from the fold's own attribution(), never a second
// reading of the rules -- an explanation that can disagree with the figures is worse
// than none. That is what the last checks here pin.
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond) {
        const hit = Array.isArray(val) ? val.some((x) => cond.$in.includes(x)) : cond.$in.includes(val);
        if (!hit) return false;
      }
    } else if (Array.isArray(val)) { if (!val.includes(cond)) return false; }
    else if (val !== cond) return false;
  }
  return true;
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) { Object.assign(f, set); return { matchedCount: 1 }; }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { upsertedCount: 1 }; }
    return { matchedCount: 0 };
  }
  async bulkWrite(ops) { for (const o of ops) await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert }); return {}; }
  async deleteMany() { return { deletedCount: 0 }; }
  async deleteOne() { return { deletedCount: 0 }; }
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, batchSize() { return this; },
      async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
  }
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$match) rows = rows.filter((d) => matches(d, st.$match));
      else if (st.$addFields) rows = rows.map((d) => {
        const add = {};
        // _k = every ledger key on the voucher; _bl = the ledger each bill allocation
        // names. Which one the stage asks for decides what is computed.
        if ('_k' in st.$addFields) add._k = Object.keys(d.ledgers || {}).concat(Object.keys(d.party_ledgers || {}));
        if ('_bl' in st.$addFields) add._bl = (d.bills || []).map((b) => b.ledger);
        return { ...d, ...add };
      });
      else if (st.$sort) { const k = Object.keys(st.$sort)[0]; rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * st.$sort[k]); }
      else if (st.$limit) rows = rows.slice(0, st.$limit);
      else if (st.$project) rows = rows.map((d) => { const o = {}; for (const k of Object.keys(st.$project)) if (st.$project[k] === 1 && d[k] !== undefined) o[k] = d[k]; return o; });
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
const app = require('./server');

let fails = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };

let n = 0;
const V = (branch, date, ledgers, party_ledgers, type) => ({
  _id: branch + ':' + (++n), guid: 'g' + n, branch, date, no: 'V' + n,
  type: type || 'Sales', ledgers, party_ledgers,
});

(async () => {
  // One customer, three ledgers -- which is the shape that started all this.
  fakeDb.collection('masters').docs.push({ branch: 'ahm',
    ledgers: {
      'Export Sales': 'Sales Accounts', 'Shipping Charges': 'Direct Incomes',
      'Carbonlite Print & Publishing': 'Export - S/Dr',
      'Carbonlite Print & Publishing- DR': 'Export - S/Dr',
      'Carbonlite Print & Publishing (AHD)': 'Export - S/Dr',
      'Bigger Customer': 'Export - S/Dr',
      'Bad Debts': 'Indirect Expenses',
      'CDC Kolkata': 'Branch / Divisions',
    },
    ids: { 'Carbonlite Print & Publishing (AHD)': 'guid-carbon' },
    groups: {
      'Sales Accounts': 'Revenue Account', 'Direct Incomes': 'Revenue Account',
      'Indirect Expenses': 'Revenue Account',
      'Export - S/Dr': 'Sundry Debtors', 'Sundry Debtors': 'Current Assets',
      'Branch / Divisions': 'Capital Account',
      'Current Assets': 'Capital Account', 'Revenue Account': null, 'Capital Account': null } });

  const vs = fakeDb.collection('vouchers').docs;
  // a) a plain sale -- counts for this customer
  vs.push(V('ahm', '20260502', { 'Export Sales': 5110000 }, { 'Carbonlite Print & Publishing': -5110000 }));
  // b) a sale where ANOTHER debtor is bigger -- the whole invoice goes to them
  vs.push(V('ahm', '20260513', { 'Export Sales': 4001000 },
    { 'Bigger Customer': -9000000, 'Carbonlite Print & Publishing': -4001000 }));
  // c) a journal with no revenue leg at all -- counts for nobody, on either page
  vs.push(V('ahm', '20260525', { 'Bad Debts': -222300 }, { 'Carbonlite Print & Publishing': 222300 }, 'Journal'));
  // d) the second ledger of the same customer, invoiced separately
  vs.push(V('ahm', '20260528', { 'Export Sales': 1885000 }, { 'Carbonlite Print & Publishing- DR': -1885000 }));
  // e) revenue that is NOT a Sales Account -- in Net+charges, out of Net (P&L)
  vs.push(V('ahm', '20260530', { 'Shipping Charges': 50000 }, { 'Carbonlite Print & Publishing': -50000 }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await (await fetch(base + p)).json());

  const short = await get('/api/yoy/diag?q=C');
  assert(/at least two/.test(short.error || ''), 'a one-letter search is refused rather than dumping the ledger list');

  const d = await get('/api/yoy/diag?q=Carbonlite&branch=ahm&fy=2026-27');
  assert(d.ok === true, 'the diagnostic answers');

  // ---- 1. the ledgers this name could mean ----------------------------------
  assert(d.ledgers.length === 3, 'it finds all three ledgers carrying the name, not just the one being looked at');
  const byName = {};
  d.ledgers.forEach((l) => { byName[l.name] = l; });
  assert(byName['Carbonlite Print & Publishing'].role === 'debtor',
    'and says which of them is a Sundry Debtor');
  assert(byName['Carbonlite Print & Publishing'].chain.join('>').includes('Export - S/Dr'),
    'with the group chain the classification actually walked: '
    + byName['Carbonlite Print & Publishing'].chain.join(' > '));

  // ---- 3. every voucher, and why ---------------------------------------------
  const v = {};
  d.vouchers.forEach((x) => { v[x.no] = x; });
  assert(d.vouchers.length === 5, 'every voucher touching any of the three names is listed');

  assert(v.V1.sale.attributedTo === 'Carbonlite Print & Publishing' && v.V1.sale.netpl === 5110000,
    'a plain sale is attributed to the customer, at its Net (P&L) figure');

  assert(v.V2.sale.attributedTo === 'Bigger Customer',
    'a sale where another debtor is bigger goes to THEM -- the whole invoice follows the largest party, '
    + 'which is why a customer can be on a voucher and not in its own row');

  assert(v.V3.sale.attributedTo === null && /no revenue leg/.test(v.V3.sale.why),
    'a journal with no revenue leg is counted for nobody, and says so: ' + v.V3.sale.why);

  assert(v.V4.sale.attributedTo === 'Carbonlite Print & Publishing- DR',
    'the second ledger of the same customer is its own row -- this is what makes one customer look like two');

  assert(v.V5.sale.netpl === 0 && v.V5.sale.net === 50000,
    'income that is not a Sales Account counts in Net + charges and not in Net (P&L): '
    + JSON.stringify(v.V5.sale));

  // ---- the explanation has to BE the fold, not a retelling of it --------------
  const yoy = require('./yoySummary');
  const xd = { ledgers: {}, groups: {}, ids: {} };
  const m = fakeDb.collection('masters').docs[0];
  Object.assign(xd.ledgers, m.ledgers); Object.assign(xd.groups, m.groups); Object.assign(xd.ids, m.ids);
  const S = yoy.newSummary(xd, {});
  for (const raw of vs) yoy.addVoucher(S, raw);
  const folded = yoy.partyDetailOf(S)['ahm|sales|netpl'];
  const may = (name) => ((folded[name] || {})['2026-27'] || [])[1] || 0;
  let mismatch = null;
  for (const x of d.vouchers) {
    if (!x.sale.attributedTo) continue;
    if (may(x.sale.attributedTo) === 0) mismatch = x.sale.attributedTo;
  }
  assert(!mismatch, 'every party the diagnostic names actually carries the figure in the stored fold'
    + (mismatch ? ' -- ' + mismatch + ' does not' : ''));
  assert(may('Carbonlite Print & Publishing') === 5110000
      && may('Carbonlite Print & Publishing- DR') === 1885000
      && may('Bigger Customer') === 4001000,
    'and the totals it explains are the totals the fold stored, to the rupee');

  // ---- what the fold has stored ----------------------------------------------
  const store = fakeDb.collection('yoy_party');
  store.docs.push({ _id: 'ahm|sales|netpl#0', key: 'ahm|sales|netpl', part: 0,
    ledgers: { 'Carbonlite Print & Publishing': { '2026-27': [0, 5110000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } });
  const d2 = await get('/api/yoy/diag?q=Carbonlite&branch=ahm&fy=2026-27');
  assert(d2.stored['Carbonlite Print & Publishing']['sales|netpl']['2026-27'][1] === 5110000,
    'the stored month is shown, so a stale rebuild is visible rather than guessed at');

  // ---- the bills behind the outstanding figure -------------------------------
  // A party's outstanding is the uploaded CSV plus the invoices inside the loaded
  // date range. The question that brought this on -- "Tally says two bills are open
  // and the site does not show them" -- is answered by seeing both sources at once.
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:b1', guid: 'gb1', branch: 'kol', date: '20251007', no: 'CDC/4919/25-26', type: 'Sales',
    ledgers: { 'Export Sales': 61705 },
    party_ledgers: { 'Carbonlite Print & Publishing': -61705 },
    bills: [{ ledger: 'Carbonlite Print & Publishing', ref: 'CDC/4919/25-26', type: 'New Ref', amount: -61705 }],
  });
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:b2', guid: 'gb2', branch: 'kol', date: '20251120', no: 'BR/9', type: 'Bank Receipt',
    ledgers: {}, party_ledgers: { 'Carbonlite Print & Publishing': 15064 },
    bills: [{ ledger: 'Carbonlite Print & Publishing', ref: 'CDC/4919/25-26', type: 'Agst Ref', amount: 15064 }],
  });
  fakeDb.collection('inputfiles').docs.push({
    _id: 'inputs',
    kolBillsRecv: 'Ledger Outstandings\nDate,Ref. No.,Party,Amount,Due on,Overdue\n'
      + '7-Oct-25,CDC/4919/25-26,Carbonlite Print & Publishing,"46,641.00 Dr",6-Dec-25,271\n',
    kolBillsRecvUpdatedAt: new Date('2026-06-01T00:00:00Z'),
  });

  const b = (await get('/api/yoy/diag?q=Carbonlite&branch=kol')).bills;
  assert(b.csv.kolBillsRecv.uploaded && b.csv.kolBillsRecv.uploaded.slice(0, 10) === '2026-06-01',
    'the uploaded file says WHEN it was uploaded -- a stale snapshot is the usual answer');
  assert(b.csv.kolBillsRecv.mine.length === 1 && b.csv.kolBillsRecv.mine[0].ref === 'CDC/4919/25-26'
    && b.csv.kolBillsRecv.mine[0].amount === 46641,
    "and this party's own bills in it, at the figure the file carries");
  assert(b.csv.kolBillsPay.uploaded === null,
    'a file that was never uploaded says so rather than looking empty');

  const r = b.refs['CDC/4919/25-26'];
  assert(r && r.raised === 61705 && r.settled === 15064 && r.net === 46641,
    'the vouchers themselves show the bill raised, what was settled against it and what is still open: '
    + JSON.stringify(r));
  assert(b.allocations.length === 2, 'every allocation on that reference is listed, receipts included');

  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:b3', guid: 'gb3', branch: 'kol', date: '20260128', no: 'CDC/10310/25-26', type: 'Sales',
    ledgers: { 'Export Sales': 23423 }, party_ledgers: { 'Carbonlite Print & Publishing': -23423 },
    bills: [{ ledger: 'Carbonlite Print & Publishing', ref: 'CDC/10310/25-26', type: 'New Ref', amount: -23423 }],
  });
  const b2 = (await get('/api/yoy/diag?q=Carbonlite&branch=kol')).bills;
  assert(b2.onlyInVouchers.indexOf('CDC/10310/25-26') >= 0,
    'a bill the vouchers carry and the uploaded file does not is named -- the file is older than the bill');
  assert(b2.onlyInCsv.length === 0,
    'and nothing is wrongly reported as file-only when the vouchers have it too');

  server.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\n== the diagnostic explains a party ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
