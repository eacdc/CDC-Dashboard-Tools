// GET /api/loans end to end: which ledgers it decides are borrowings, where it looks for
// them, and what it refuses.
//
// The arithmetic is pinned in test_loans_fake.js against loanMovement.js directly. What
// this file is for is the adapter -- and the adapter is where the interesting mistake
// lives: a packing-credit account sits under Bank OD A/c, which the extractor files under
// `party_ledgers`, while a secured loan lands in `ledgers`. Reading only one of those two
// maps is exactly how every PCFC account stayed invisible to the cashflow tab for a year,
// so the fixture puts one borrowing in each map and insists both are found.

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
const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= 0.5;

let n = 0;
// `pl` is party_ledgers and `ld` is ledgers, kept apart on purpose: which map a loan
// lands in depends on its group, and this endpoint has to read both.
const V = (branch, date, pl, ld, extra) => ({
  _id: branch + ':' + (++n), guid: 'g' + n, branch, date, no: 'V' + n, type: 'Journal',
  party_ledgers: pl || {}, ledgers: ld || {}, ...(extra || {}),
});

(async () => {
  fakeDb.collection('masters').docs.push({
    branch: 'kol',
    ledgers: {
      'PCFC Loan 0012': 'Bank OD A/c',            // party_ledgers, per the extractor
      'HDFC Term Loan': 'Secured Loans',          // ledgers
      'Director Loan': 'Unsecured Loans',
      'Buyers Credit SBI': 'Current Liabilities', // counted by its NAME
      'Staff Loan Given': 'Loans & Advances (Asset)',
      'Term Loan Interest': 'Indirect Expenses',
      'HDFC Current A/c': 'Bank Accounts',
    },
    groups: {
      'Bank OD A/c': 'Loans (Liability)', 'Secured Loans': 'Loans (Liability)',
      'Unsecured Loans': 'Loans (Liability)', 'Loans (Liability)': 'Capital Account',
      'Current Liabilities': 'Capital Account', 'Loans & Advances (Asset)': 'Current Assets',
      'Bank Accounts': 'Current Assets', 'Current Assets': 'Capital Account',
      'Indirect Expenses': 'Revenue Account', 'Capital Account': null, 'Revenue Account': null,
    },
    ids: {},
    // Tally-raw, so a liability stands Cr (+ve). 1 Apr 2025: PCFC 40L, term loan 1 Cr.
    opening: { 'PCFC Loan 0012': 4000000, 'HDFC Term Loan': 10000000, 'Staff Loan Given': -250000 },
    openingAsOn: '20250401',
  });

  const vs = fakeDb.collection('vouchers').docs;
  // +ve = Cr = borrowed. -ve = Dr = repaid.
  vs.push(V('kol', '20260410', { 'PCFC Loan 0012': 2500000 }, { 'Export Sales': -2500000 }));
  vs.push(V('kol', '20260610', { 'PCFC Loan 0012': -1500000, 'HDFC Current A/c': 1500000 }, {}));
  vs.push(V('kol', '20260505', {}, { 'HDFC Term Loan': -1000000, 'Interest Paid': 1000000 }));
  // A drawdown and a repayment on ONE day: both must survive.
  vs.push(V('kol', '20260715', { 'PCFC Loan 0012': 800000 }, {}));
  vs.push(V('kol', '20260715', { 'PCFC Loan 0012': -300000 }, {}));
  // Drafts: a cancelled and an optional voucher must reach no figure here either.
  vs.push(V('kol', '20260720', { 'PCFC Loan 0012': 9999999 }, {}, { cancelled: true }));
  vs.push(V('kol', '20260721', { 'PCFC Loan 0012': 8888888 }, {}, { optional: true }));
  // Money we LENT, which is not borrowing however the word reads.
  vs.push(V('kol', '20260801', {}, { 'Staff Loan Given': -50000 }));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await (await fetch(base + p)).json());

  // ---- what it refuses -----------------------------------------------------
  const noDates = await get('/api/loans?branch=kol');
  assert(noDates.ok === false && /from and to/.test(noDates.error || ''),
    'a window is required rather than guessed at');
  const backwards = await get('/api/loans?branch=kol&from=20260630&to=20260401');
  assert(backwards.ok === false && /before/.test(backwards.error || ''),
    'a window that ends before it starts is refused, and said to be');
  const tooMany = await get('/api/loans?branch=kol&from=20150401&to=20261106&bucket=day');
  assert(tooMany.ok === false && /too many/.test(tooMany.error || '') && /week|month/.test(tooMany.error || ''),
    'a decade asked for day by day is refused, and the refusal names the bucket to use instead');

  // ---- the statement -------------------------------------------------------
  const j = await get('/api/loans?branch=kol&from=20260401&to=20260731&bucket=month');
  assert(j.ok === true, 'the loan movement answers');
  const names = j.loans.map((l) => l.ledger).sort();
  assert(names.join(' | ') === 'Buyers Credit SBI | Director Loan | HDFC Term Loan | PCFC Loan 0012',
    'every borrowing is listed and nothing else is: got ' + names.join(' | '));
  assert(!names.includes('Staff Loan Given'), 'money WE lent out is not reported as a borrowing');
  assert(!names.includes('HDFC Current A/c'), 'nor is the bank account the repayment came out of');
  assert((j.nearMisses || []).some((x) => x.ledger === 'Term Loan Interest'),
    'an expense named like a loan is NOT counted but IS named, so a real loan filed wrongly cannot hide');

  const pcfc = j.loans.find((l) => l.ledger === 'PCFC Loan 0012');
  assert(pcfc && pcfc.kind === 'od_cc',
    'the packing-credit account is found at all -- it lives in party_ledgers, where only half the old code looked');
  assert(near(pcfc.opening, 4000000),
    'its opening is Tally own opening balance on the day it stands (got ' + (pcfc && pcfc.opening) + ')');
  assert(near(pcfc.drawn, 3300000) && near(pcfc.repaid, 1800000),
    'drawdowns and repayments are kept apart, including two on the same day (got '
    + (pcfc && pcfc.drawn) + ' / ' + (pcfc && pcfc.repaid) + ')');
  assert(near(pcfc.closing, 5500000),
    'and it closes at opening + drawn - repaid (got ' + (pcfc && pcfc.closing) + ')');
  assert(pcfc.branches.join(',') === 'kol', 'the branch the postings came from is reported');

  const term = j.loans.find((l) => l.ledger === 'HDFC Term Loan');
  assert(near(term.opening, 10000000) && near(term.repaid, 1000000) && near(term.closing, 9000000),
    'a secured loan in the OTHER ledger map is found and reduced by its repayment (got '
    + JSON.stringify({ o: term.opening, r: term.repaid, c: term.closing }) + ')');

  const dormant = j.loans.find((l) => l.ledger === 'Director Loan');
  assert(dormant && dormant.moved === false && near(dormant.closing, 0),
    'a borrowing account with no balance and no movement is still listed, as nil rather than absent');

  assert(near(j.total.closing, j.total.opening + j.total.drawn - j.total.repaid),
    'the grand total obeys the same arithmetic as every row in it');
  assert(j.scale === 'cr-positive' && near(pcfc.closing, Math.abs(pcfc.closing)),
    'and a loan outstanding comes back POSITIVE, so nobody has to hold a sign convention in their head');

  // Drafts excluded.
  assert(pcfc.drawn < 9000000,
    'a cancelled or optional voucher reaches no figure here, as it reaches none anywhere else');

  // ---- openings that were never pulled -------------------------------------
  const both = await get('/api/loans?branch=all&from=20260401&to=20260731&bucket=month');
  assert(both.ok === true && (both.notes || []).some((s) => /ahm/.test(s) && /not been pulled/.test(s)),
    'a branch whose opening balances never arrived is NAMED, so movement is not read as a balance');

  // ---- the opening must not predate the vouchers ---------------------------
  // A balance here is Tally's opening on its own day plus every posting since. If the
  // oldest voucher held is NEWER than that day, the postings in between are in neither
  // half and every balance is wrong by whatever happened in them -- silently, because
  // each row still adds up. On a sweeping OD that is the whole difference: the account is
  // paid down by postings we do not hold, so it reads near its old high for ever.
  // The live books showed this as a 59.62 Cr swing in the wrong DIRECTION on one OD.
  fakeDb.collection('masters').docs.push({
    branch: 'ahm',
    ledgers: { 'Ahm Citi OD': 'Bank OD A/c' },
    groups: { 'Bank OD A/c': 'Loans (Liability)', 'Loans (Liability)': 'Capital Account', 'Capital Account': null },
    ids: {},
    opening: { 'Ahm Citi OD': 393471000 },
    openingAsOn: '20230401',            // books begin 2023 ...
  });
  vs.push(V('ahm', '20260415', { 'Ahm Citi OD': 100000 }, {}));   // ... but we hold 2026 only
  const gap = await get('/api/loans?branch=ahm&from=20260401&to=20260430&bucket=month');
  assert(gap.ok === true, 'the endpoint still answers when the openings predate the vouchers');
  assert((gap.notes || []).some((s) => /20230401/.test(s) && /20260415/.test(s) && /neither half/.test(s)),
    'and it SAYS the opening stands on a day older than the oldest voucher held, naming both days');
  assert((gap.notes || []).some((s) => /\b1110 days\b/.test(s)),
    'and counts the gap in days, because two dates do not say whether it can explain anything');
  assert((gap.notes || []).some((s) => /-From 20230401/.test(s)),
    'with the back-fill that would close it, because a warning nobody can act on is noise');
  assert(gap.firstVoucher && gap.firstVoucher.ahm === '20260415',
    'the oldest voucher held per branch comes back, so a caller can check the span itself');

  // A ONE-DAY gap must not be reported as if every figure were wrong. The guard cannot
  // tell a day on which nothing was posted from a day whose entries are missing, and the
  // live books threw exactly this: openings on 20250401, oldest voucher 20250402. Saying
  // "every balance on this page is wrong" over one possibly-empty day is how a page stops
  // being believed.
  fakeDb.collection('masters').docs.find((d) => d.branch === 'ahm').openingAsOn = '20260414';
  const oneDay = await get('/api/loans?branch=ahm&from=20260401&to=20260430&bucket=month');
  assert((oneDay.notes || []).some((s) => /1 day\(s\)/.test(s) && /this is fine/.test(s)),
    'a one-day gap says it changes nothing if that day was empty, instead of condemning every figure');
  assert(!(oneDay.notes || []).some((s) => /every balance below is out/.test(s)),
    'and it does not claim the balances are out, because the guard cannot know that');
  fakeDb.collection('masters').docs.find((d) => d.branch === 'ahm').openingAsOn = '20230401';

  // ---- a quiet window still carries the balance ----------------------------
  const quiet = await get('/api/loans?branch=kol&from=20260801&to=20261031&bucket=month');
  assert(quiet.ok === true && quiet.periods.length === 3
    && quiet.periods.every((p) => p.drawn === 0 && p.repaid === 0),
    'a window where nothing was borrowed or repaid still lists its months');
  assert(near(quiet.total.opening, j.total.closing) && near(quiet.total.closing, j.total.opening + j.total.drawn - j.total.repaid),
    'and opens exactly where the previous window closed -- the statement is continuous across windows');

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall good');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
