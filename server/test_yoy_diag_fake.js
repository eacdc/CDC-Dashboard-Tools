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
// Mongo resolves a dotted path through arrays: {'bills.ref': ...} matches when ANY
// element's ref matches. The bills queries rely on that.
function valueAt(doc, path) {
  if (!path.includes('.')) return doc[path];
  let cur = [doc];
  for (const part of path.split('.')) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      const v = Array.isArray(c) ? undefined : c[part];
      if (Array.isArray(v)) next.push(...v); else if (v !== undefined) next.push(v);
      if (Array.isArray(c)) for (const el of c) { const w = el && el[part]; if (w !== undefined) next.push(w); }
    }
    cur = next;
  }
  return cur.length > 1 ? cur : cur[0];
}
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = valueAt(doc, k);
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
  // Enough of Mongo's expression language for the pipelines this file exercises:
  // a path, a substring of one, a size, a comparison, a null default, a condition.
  static expr(doc, e) {
    if (e === null || typeof e === 'number' || typeof e === 'boolean') return e;
    if (typeof e === 'string') {
      if (e[0] !== '$') return e;
      return e.slice(1).split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
    }
    if (Array.isArray(e)) return e.map((x) => Col.expr(doc, x));
    const op = Object.keys(e)[0], a = e[op];
    if (op === '$substrBytes') { const [v, st, len] = Col.expr(doc, a); return String(v).substr(st, len); }
    if (op === '$ifNull') { const [v, d] = a; const r = Col.expr(doc, v); return (r == null) ? Col.expr(doc, d) : r; }
    if (op === '$size') { const r = Col.expr(doc, a); return Array.isArray(r) ? r.length : 0; }
    if (op === '$gt') { const [x, y] = Col.expr(doc, a); return x > y; }
    if (op === '$lt') { const [x, y] = Col.expr(doc, a); return x < y; }
    if (op === '$multiply') return Col.expr(doc, a).reduce((x, y) => x * y, 1);
    if (op === '$cond') { const [c, t, f] = a; return Col.expr(doc, c) ? Col.expr(doc, t) : Col.expr(doc, f); }
    if (op === '$sum') return Col.expr(doc, a);
    if (op === '$min') return Col.expr(doc, a);
    if (op === '$map') {
      const input = Col.expr(doc, a.input) || [];
      return input.map((it) => Col.expr({ ...doc, $$this: it, this: it },
        typeof a.in === 'string' ? a.in.replace('$$this', '$this') : a.in));
    }
    if (op === '$concatArrays') return Col.expr(doc, a).reduce((x, y) => x.concat(y), []);
    if (op === '$objectToArray') { const o = Col.expr(doc, a) || {};
      return Object.keys(o).map((k) => ({ k, v: o[k] })); }
    throw new Error('fake aggregate: unsupported operator ' + op);
  }
  aggregate(stages) {
    let rows = this.docs.slice();
    for (const st of stages) {
      if (st.$unwind) {
        const path = st.$unwind.replace(/^\$/, '');
        const next = [];
        for (const d of rows) for (const item of (d[path] || [])) next.push({ ...d, [path]: item });
        rows = next;
        continue;
      }
      if (st.$group) {
        const spec = st.$group, byKey = new Map();
        for (const d of rows) {
          const id = (spec._id && typeof spec._id === 'object' && !Array.isArray(spec._id))
            ? Object.fromEntries(Object.keys(spec._id).map((k) => [k, Col.expr(d, spec._id[k])]))
            : Col.expr(d, spec._id);
          const key = JSON.stringify(id);
          let acc = byKey.get(key);
          if (!acc) { acc = { _id: id }; byKey.set(key, acc); }
          for (const f of Object.keys(spec)) {
            if (f === '_id') continue;
            const op = Object.keys(spec[f])[0], v = Col.expr(d, spec[f][op]);
            if (op === '$sum') acc[f] = (acc[f] || 0) + (typeof v === 'number' ? v : 0);
            else if (op === '$min') acc[f] = (acc[f] === undefined || v < acc[f]) ? v : acc[f];
          }
        }
        rows = [...byKey.values()];
        continue;
      }
      if (st.$match) rows = rows.filter((d) => matches(d, st.$match));
      else if (st.$addFields) rows = rows.map((d) => {
        const add = {};
        // _k = every ledger key on the voucher; _bl = the ledger each bill allocation
        // names. Which one the stage asks for decides what is computed.
        if ('_k' in st.$addFields) add._k = Object.keys(d.ledgers || {}).concat(Object.keys(d.party_ledgers || {}));
        if ('_bl' in st.$addFields) add._bl = (d.bills || []).map((b) => b.ledger);
        return { ...d, ...add };
      });
      else if (st.$sort) { const k = Object.keys(st.$sort)[0];
        const key = (r) => (k === '_id' && r._id && typeof r._id === 'object' ? JSON.stringify(r._id) : r[k]);
        rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * st.$sort[k]); }
      else if (st.$limit) rows = rows.slice(0, st.$limit);
      // $project both selects and COMPUTES. Copying only the `field: 1` entries and
      // dropping the expressions would leave a stage that quietly produces nothing,
      // and a test that then passes for the wrong reason.
      else if (st.$project) rows = rows.map((d) => {
        const o = {};
        for (const k of Object.keys(st.$project)) {
          const spec = st.$project[k];
          if (spec === 1) { if (d[k] !== undefined) o[k] = d[k]; }
          else if (spec !== 0) o[k] = Col.expr(d, spec);
        }
        return o;
      });
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
      // A real Sundry Debtor that no uploaded file names: it must reach the balance
      // reading on its own group, or a party paid entirely on account would be
      // dropped from the comparison and its balance read as zero for the wrong reason.
      'Onaccount Traders': 'Export - S/Dr',
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

  // ---- can the uploaded bills file be retired? -------------------------------
  // The pipeline has carried bill-wise allocations since August 2026, so the
  // outstanding figure could come from the vouchers alone -- but only if the
  // vouchers actually cover every bill the file still shows open. Dropping the file
  // on the strength of "they probably do" would lose exactly the bills it alone
  // knows. So the question is measured, and the answer is a count, not a hunch.
  const cov = await get('/api/bills/coverage');
  assert(cov.ok === true, 'the coverage check answers');
  assert(cov.branches.kol && cov.branches.kol.firstMonthWithBills === '202510',
    'it says how far back the vouchers carry allocations, per branch: '
    + JSON.stringify(cov.branches.kol && cov.branches.kol.firstMonthWithBills));
  assert(cov.branches.kol.withBills === 3 && cov.branches.kol.vouchers === 3,
    'and how many vouchers carry them against how many there are');

  const recv = cov.csv.kolBillsRecv;
  assert(recv.rows === 1 && recv.matched === 1 && recv.missing === 0,
    'the bill the file shows open is found on a voucher, so it is not unique to the file');
  assert(cov.verdict.csvStillNeeded === false && /no longer the source/.test(cov.verdict.says),
    'and the verdict says so in words, rather than leaving it to be inferred');

  // Tally lets a bill reference be re-typed after the invoice is raised, and the file
  // is an old snapshot -- so it can name a reference no voucher carries while the
  // invoice itself sits right there under a new name. Counting that as a loss would
  // keep the upload alive for a bill that was never missing. It is found by the
  // voucher NUMBER the reference was copied from, and only when the money agrees.
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:b4', guid: 'gb4', branch: 'kol', date: '20260210', no: 'CDC/7418/24-25', type: 'Sales',
    ledgers: { 'Export Sales': 4900 }, party_ledgers: { 'Carbonlite Print & Publishing': -5782 },
    bills: [{ ledger: 'Carbonlite Print & Publishing', ref: '24-25/8842', type: 'New Ref', amount: -5782 }],
  });
  fakeDb.collection('inputfiles').docs[0].kolBillsRecv +=
    '13-Feb-25,CDC/7418/24-25,Carbonlite Print & Publishing,"5,782.00 Dr",15-Mar-25,16\n';
  const covR = await get('/api/bills/coverage');
  assert(covR.csv.kolBillsRecv.renamed === 1 && covR.csv.kolBillsRecv.missing === 0,
    'a bill Tally re-referenced is found on its voucher, NOT counted as lost with the file');
  assert(covR.csv.kolBillsRecv.renamedSample[0].renamedTo === '24-25/8842',
    'and the reference the voucher now carries is named, so the pair can be eyeballed');
  assert(covR.verdict.csvStillNeeded === false && covR.verdict.billsFoundRenamed === 1,
    'so the verdict stays green, and says how many were only re-named');

  // But a voucher of that number carrying a DIFFERENT amount is a different invoice,
  // and must not be quietly accepted as the missing one.
  fakeDb.collection('inputfiles').docs[0].kolBillsRecv +=
    '13-Feb-25,CDC/7418/24-25,Carbonlite Print & Publishing,"99,999.00 Dr",15-Mar-25,16\n';
  const covW = await get('/api/bills/coverage');
  assert(covW.csv.kolBillsRecv.missing === 1 && covW.csv.kolBillsRecv.missingTotal === 99999,
    'a bill whose money does not match that voucher is still reported missing, not rescued by its number');
  fakeDb.collection('inputfiles').docs[0].kolBillsRecv =
    fakeDb.collection('inputfiles').docs[0].kolBillsRecv.replace(
      '13-Feb-25,CDC/7418/24-25,Carbonlite Print & Publishing,"99,999.00 Dr",15-Mar-25,16\n', '');

  // A bill the file alone knows about must flip the verdict and be NAMED -- that is
  // the whole safety of the measurement.
  fakeDb.collection('inputfiles').docs[0].kolBillsRecv +=
    '1-Apr-24,CDC/OLD/24-25,Carbonlite Print & Publishing,"90,000.00 Dr",1-May-24,500\n';
  const cov2 = await get('/api/bills/coverage');
  assert(cov2.csv.kolBillsRecv.missing === 1 && cov2.csv.kolBillsRecv.missingTotal === 90000,
    'a bill on no voucher is counted, with its money');
  assert(cov2.csv.kolBillsRecv.missingSample[0].ref === 'CDC/OLD/24-25',
    'and named, so the year to re-pull is obvious');
  assert(cov2.verdict.csvStillNeeded === true && /would lose exactly those/.test(cov2.verdict.says),
    'and the verdict turns to "not yet", saying what dropping the file would cost');

  // ---- does outstanding come out RIGHT from the vouchers? --------------------
  // Coverage says every bill is somewhere in the vouchers. That is not the same as
  // the figure agreeing: an allocation could be netted the wrong way round and every
  // bill would still be "present". So both sides are read at the same instant -- the
  // date Tally printed its snapshot -- and compared party by party, because two
  // errors cancel in a total and cannot in a list of parties.
  // Due 6-Nov, overdue by 14 days: the file itself says it was printed on 20 Nov 2025,
  // which is the only honest date to compare the vouchers at. The newest BILL date
  // (7 Oct) is when the invoice was raised and would silently drop the receipt.
  fakeDb.collection('inputfiles').docs[0].kolBillsRecv =
    'Ledger Outstandings\nDate,Ref. No.,Party,Amount,Due on,Overdue\n'
    + '7-Oct-25,CDC/4919/25-26,Carbonlite Print & Publishing,"46,641.00 Dr",6-Nov-25,14\n';
  const aud = await get('/api/bills/audit');
  assert(aud.ok === true && aud.asOn === '20251120' && aud.snapshotFrom === 'overdue days',
    'the file says when Tally printed it -- due date plus overdue days, not the newest invoice: ' + aud.asOn);
  const rf = aud.branches.kol;
  assert(rf.csvTotal === 46641 && rf.vouchersTotal === 46641 && rf.diff === 0,
    'the vouchers, netted to that date, give Tally\'s own figure: ' + JSON.stringify([rf.csvTotal, rf.vouchersTotal]));
  assert(rf.parties === 1 && rf.agree === 1 && rf.differ === 0,
    'and they agree party by party, not merely in the total');
  assert(aud.verdict.safeToSwitch === true, 'so the verdict says the switch is safe');

  assert(rf.vouchersTotal === 61705 - 15064,
    'the receipt IS netted off the bill it was allocated against, rather than the invoice standing at its full value');

  // Asked at today's date instead, the vouchers carry invoices raised after the file
  // was printed and the file cannot. That gap is the reason to stop uploading it --
  // and it must show up as a difference, not be smoothed over.
  const aud2 = await get('/api/bills/audit?asOn=20260228');
  assert(aud2.branches.kol.vouchersTotal === 46641 + 23423 + 5782,
    'invoices raised after the snapshot are open in the vouchers: ' + aud2.branches.kol.vouchersTotal);
  assert(aud2.branches.kol.differ === 1 && aud2.verdict.safeToSwitch === false,
    'and comparing across different dates is reported as a difference rather than hidden');

  // Ahmedabad's vouchers start after this snapshot, so every bill of its would read
  // as lost. That is the question being wrong, not the answer, and it must say so
  // rather than counting against the verdict.
  assert(aud.branches.ahm.coversDate === false && /nothing to compare/.test(aud.branches.ahm.note || ''),
    'a branch whose vouchers do not reach the snapshot date is set aside, with the reason');
  assert(aud.verdict.branchesNotCompared.indexOf('ahm') >= 0,
    'and named in the verdict, so its absence is not mistaken for agreement');

  // A party in one source and not the other has to be NAMED and sided, since that is
  // the shape the real gaps take: a bill raised after the snapshot, or one the
  // vouchers never received.
  fakeDb.collection('inputfiles').docs[0].kolBillsRecv +=
    '1-Apr-24,CDC/GHOST/24-25,Some Other Customer,"7,000.00 Dr",1-May-24,500\n';
  const aud3 = await get('/api/bills/audit?asOn=20251120');
  const ghost = aud3.branches.kol.worst.find((r) => r.party === 'Some Other Customer');
  assert(ghost && ghost.csv === 7000 && ghost.vouchers === 0 && ghost.onlyIn === 'csv',
    'a party only Tally knows is listed with both figures and which side it came from: ' + JSON.stringify(ghost));

  // The commonest difference by far is not money at all: one customer under two
  // spellings, the bill raised against one and settled against the other, so the two
  // cancel to the rupee. Reporting those as missing money buries the handful of
  // differences that are real, so they are paired off and handed over as a merge list.
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:p1', guid: 'gp1', branch: 'kol', date: '20251110', no: 'CDC/PAIR/25-26', type: 'Sales',
    ledgers: { 'Export Sales': 250000 }, party_ledgers: { 'Vijay Shree Textiles Pvt Ltd': -250000 },
    bills: [{ ledger: 'Vijay Shree Textiles Pvt Ltd', ref: 'CDC/PAIR/25-26', type: 'New Ref', amount: -250000 }],
  });
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:p2', guid: 'gp2', branch: 'kol', date: '20251112', no: 'BR/77', type: 'Bank Receipt',
    ledgers: {}, party_ledgers: { 'Vijay Shree Textiles': 250000, 'Citi Bank': -250000 },
    bills: [{ ledger: 'Vijay Shree Textiles', ref: 'CDC/PAIR/25-26', type: 'Agst Ref', amount: 250000 }],
  });
  const audP = await get('/api/bills/audit?asOn=20251120');
  const pair = audP.branches.kol.pairs.find((p) => p.amount === 250000);
  assert(pair && /Vijay Shree/.test(pair.a.party) && /Vijay Shree/.test(pair.b.party),
    'two spellings of one customer that cancel exactly are paired off, not counted as money: ' + JSON.stringify(pair));
  assert(audP.branches.kol.namePairs === 1
    && !audP.branches.kol.worst.some((r) => /Vijay Shree/.test(r.party)),
    'and are kept out of the list of real differences, which is what the merge list is for');

  // But two unrelated parties that merely differ by the same amount must NOT be
  // declared one customer -- the cancellation alone is not enough, the names have to
  // share a word.
  assert(audP.branches.kol.pairs.every((p) => p.a.party !== 'Some Other Customer'),
    'a coincidence of amount does not pair two names with nothing in common');

  // Nearly a thousand differing rows is not a list anyone reads, so they are counted
  // by SHAPE, each class with its money. And the tell within a class is a bill
  // reference we only ever saw one side of -- an invoice with no settlement, or
  // settlements against an invoice raised before the vouchers we hold begin.
  const audL = await get('/api/bills/audit?asOn=20260228');
  const sh = audL.branches.kol.shape;
  assert(sh.onlyInTally && sh.onlyInTally.parties === 1 && sh.onlyInTally.money === -7000,
    'a party only Tally knows is counted in its own class, with its money: ' + JSON.stringify(sh.onlyInTally));
  assert(sh.bothButDiffer && sh.bothButDiffer.parties === 1,
    'and a party both sources know but disagree on is counted apart from it: ' + JSON.stringify(sh.bothButDiffer));
  const cl = audL.branches.kol.worst.find((r) => r.party === 'Carbonlite Print & Publishing');
  assert(cl && cl.openRefs === 3 && cl.oneSidedRefs === 2,
    'each row says how many of its open references we hold only one side of, which is where the answer usually is: '
    + JSON.stringify(cl && [cl.openRefs, cl.oneSidedRefs]));

  // ---- the ledger balance, which needs no references at all -------------------
  // Bill-reference netting is only as good as the references Tally was given. A
  // receipt posted ON ACCOUNT settles the customer without naming a bill, so every
  // invoice reads open forever though the account is square. The balance cannot drift
  // that way -- it is every posting to the name, added up -- so it is read alongside.
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:oa1', guid: 'goa1', branch: 'kol', date: '20260220', no: 'CDC/OA/25-26', type: 'Sales',
    ledgers: { 'Export Sales': 400000 }, party_ledgers: { 'Onaccount Traders': -400000 },
    bills: [{ ledger: 'Onaccount Traders', ref: 'CDC/OA/25-26', type: 'New Ref', amount: -400000 }],
  });
  fakeDb.collection('vouchers').docs.push({
    _id: 'kol:oa2', guid: 'goa2', branch: 'kol', date: '20260225', no: 'BR/99', type: 'Bank Receipt',
    ledgers: {}, party_ledgers: { 'Onaccount Traders': 400000, 'Citi Bank': -400000 },
  });
  const audB = await get('/api/bills/audit?asOn=20260228');
  const oa = audB.branches.kol.worst.find((r) => r.party === 'Onaccount Traders');
  assert(oa && oa.vouchers === 400000 && oa.balance === 0,
    'the bills read the invoice as open, the balance reads the account as square: ' + JSON.stringify(oa && [oa.vouchers, oa.balance]));
  assert(oa && oa.balanceDiff === 0,
    'and it is the BALANCE that agrees with Tally, which is the whole reason for reading it');
  assert(audB.branches.kol.balanceAgree >= 1 && typeof audB.branches.kol.balanceTotal === 'number',
    'the branch reports how many parties agree on balance, alongside how many agree on bills');

  // Only ledgers that can BE outstanding. Every posting in the books nets to zero by
  // double entry, so sweeping the sales and bank ledgers in gives a grand total of
  // exactly nothing -- a balance total of 0 across thousands of "parties" is the
  // signature of that mistake, not of a company that owes nobody anything.
  assert(!audB.branches.kol.worst.some((r) => /Citi Bank|Export Sales/.test(r.party)),
    'a bank or a sales account is not a party and never appears among them');
  assert(audB.branches.kol.balanceTotal !== 0,
    'so the balance total is the money outstanding, not the zero every full set of books adds up to');

  server.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\n== the diagnostic explains a party ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
