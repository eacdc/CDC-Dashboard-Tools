// Tests the year-on-year endpoints against a stubbed Mongo: the background rebuild,
// the cached read, the partial (one-year) rebuild, and the automatic refresh that
// follows an ingest. No DB, no browser -- the figures themselves are checked against
// the real dashboard in test_yoy_fake.js.
// A dotted path, array indices included -- `details.items.0` is how Mongo is asked
// whether a voucher carries any line items, and a stub that answered that by looking
// up a key literally named "details.items.0" would quietly match every voucher.
function valueAt(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter)) {
    const val = valueAt(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$gte' in cond && !(val >= cond.$gte)) return false;
      if ('$lte' in cond && !(val <= cond.$lte)) return false;
      if ('$in' in cond && !cond.$in.includes(val)) return false;
      // $ne and $exists are what the cancelled/optional filters are written with, so
      // a stub that skipped them would pass a test the real database fails.
      if ('$ne' in cond && val === cond.$ne) return false;
      if ('$exists' in cond && (val !== undefined) !== !!cond.$exists) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
class Col {
  constructor() { this.docs = []; }
  async createIndex() {}
  async updateOne(filter, update, opts = {}) {
    const set = update.$set || {};
    const unset = update.$unset || {};
    const f = this.docs.find((d) => matches(d, filter));
    if (f) {
      Object.assign(f, set);
      // $unset is how a flag comes OFF -- an optional voucher confirmed in Tally. A
      // stub that ignored it would leave the draft excluded for ever and say nothing.
      for (const k of Object.keys(unset)) delete f[k];
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (opts.upsert) { this.docs.push({ ...filter, ...set }); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async bulkWrite(ops) { for (const o of ops) await this.updateOne(o.updateOne.filter, o.updateOne.update, { upsert: o.updateOne.upsert }); return { upsertedCount: ops.length, modifiedCount: 0, matchedCount: 0 }; }
  async deleteMany() { return { deletedCount: 0 }; }
  async deleteOne() { return { deletedCount: 0 }; }
  find(filter = {}) {
    const arr = this.docs.filter((d) => matches(d, filter));
    return { sort() { return this; }, limit() { return this; }, batchSize() { return this; },
      async toArray() { return arr; },
      async *[Symbol.asyncIterator]() { for (const d of arr) yield d; } };
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
const V = (branch, date, sales) => ({
  _id: branch + ':' + (++n), branch, date, type: 'Sales',
  ledgers: { 'Sales A/c': sales }, party_ledgers: { 'A Customer': -sales },
});

function post(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = JSON.stringify(body || {});
    const req = http.request({ port, path, method: 'POST', headers: Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, token ? { 'x-ingest-token': token } : {}) },
      (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}') })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const get = async (base, p) => (await fetch(base + p)).json();
const settle = async (base) => {
  for (let i = 0; i < 100; i++) {
    const d = await get(base, '/api/yoy');
    if (!d.running && d.updatedAt) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the summary never settled');
};

(async () => {
  fakeDb.collection('masters').docs.push({ branch: 'kol',
    ledgers: { 'Sales A/c': 'Sales Accounts', 'A Customer': 'Sundry Debtors', 'HDFC Bank': 'Bank Accounts',
      'B Customer': 'Sundry Debtors', 'Paper Purchase': 'Purchase Accounts', 'Paper Supplier': 'Sundry Creditors' },
    groups: { 'Sales Accounts': 'Revenue Account', 'Sundry Debtors': 'Current Assets', 'Bank Accounts': 'Current Assets', 'Purchase Accounts': 'Revenue Account', 'Sundry Creditors': 'Current Liabilities', 'Current Liabilities': 'Capital Account', 'Current Assets': 'Capital Account', 'Revenue Account': null, 'Capital Account': null },
    contacts: { 'A Customer': { gstin: '19AAAAA0000A1Z5', pan: 'AAAAA0000A', email: 'buyer@example.com',
      mobile: '9800000000', address: '12 Some Road, Kolkata', state: 'West Bengal', country: 'India' } } });
  fakeDb.collection('vouchers').docs.push(
    V('kol', '20230510', 100), V('kol', '20240610', 200), V('kol', '20250710', 300));

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;

  const before = await get(base, '/api/yoy');
  assert(before.fys.length === 0 && !before.updatedAt, 'GET answers empty and instantly before any rebuild');

  assert((await post(port, '/api/yoy/scan')).body.started === true, 'POST starts a rebuild and returns at once');
  const full = await settle(base);
  assert(full.fys.join(',') === '2023-24,2024-25,2025-26', 'every financial year present, oldest first');
  assert(full.branches.all['2024-25'].totals.revenue === 200, 'a year total is folded correctly');
  assert(full.branches.all['2025-26'].revenue[3] === 300, 'July lands in month index 3');
  assert(full.scannedVouchers === 3, 'the vouchers it read are reported');

  // A partial rebuild must leave the other years exactly as they were.
  fakeDb.collection('vouchers').docs.push(V('kol', '20240815', 555));
  assert((await post(port, '/api/yoy/scan?fy=2024-25')).body.scope.join(',') === '2024-25', 'a rebuild can be scoped to one year');
  let d = await settle(base);
  assert(d.branches.all['2024-25'].totals.revenue === 755, 'the rebuilt year picks up the new voucher');
  assert(d.branches.all['2023-24'].totals.revenue === 100, 'a year outside the scope is left untouched');
  assert(d.scannedVouchers === 2, 'the partial rebuild read only that year');

  // The Sales Analysis headline totals ride in the same document, so they splice the
  // same way -- and a party section that merged its years instead of clearing them
  // first would leave a rebuilt year showing its old figure for ever.
  const pt = () => d.partyTotals.all['sales|netpl'];
  const ptSum = (fy) => Math.round((pt()[fy] || []).reduce((a, x) => a + x, 0) * 100) / 100;
  assert(ptSum('2024-25') === 755,
    'the section total for the rebuilt year follows it: ' + JSON.stringify(pt()['2024-25']));
  assert(ptSum('2023-24') === 100,
    'and a year outside the scope keeps the total it had');
  // A year whose vouchers all went must lose its total too, not keep the last one.
  fakeDb.collection('vouchers').docs = fakeDb.collection('vouchers').docs.filter((v) => !/^2024/.test(v.date));
  await post(port, '/api/yoy/scan?fy=2024-25');
  d = await settle(base);
  assert(!pt()['2024-25'],
    'a year emptied of vouchers loses its section total rather than keeping a stale one: '
    + JSON.stringify(pt()['2024-25']));
  assert(ptSum('2023-24') === 100, 'while the untouched years are still there');
  fakeDb.collection('vouchers').docs.push(V('kol', '20240815', 755));
  await post(port, '/api/yoy/scan?fy=2024-25');
  d = await settle(base);

  // Ingest should refresh the year it touched, with nobody asking.
  const ing = await post(port, '/ingest', { branch: 'kol', from: '20230401', to: '20240331',
    vouchers: [{ guid: 'x1', date: '20230610', type: 'Sales', no: 'S9', ledgers: { 'Sales A/c': 40 }, party_ledgers: { 'A Customer': -40 } }] }, 'tok');
  assert(ing.status === 200, 'the ingest itself succeeds');
  d = await settle(base);
  assert(d.branches.all['2023-24'].totals.revenue === 140, 'ingest refreshed the year it touched, automatically');
  assert(d.branches.all['2024-25'].totals.revenue === 755, 'and left the other years alone');

  // The date span, not just its endpoints, decides which years are refreshed.
  const wide = await post(port, '/ingest', { branch: 'kol', from: '20230401', to: '20260331', vouchers: [] }, 'tok');
  assert(wide.status === 200, 'a multi-year push is accepted');
  d = await settle(base);
  assert(d.fys.join(',') === '2023-24,2024-25,2025-26', 'a range spanning years rebuilds all of them, not just the ends');


  // ---- the client list -------------------------------------------------------
  // One row per customer, its contacts off the master and its sales out of the same
  // fold the Sales Analysis tab reads. A salesperson holding this sheet next to the
  // dashboard must not be able to find two different answers for one customer.
  const cl = await get(base, '/api/clients?fromFy=2020-21');
  assert(cl.ok && cl.rows.map((r) => r.ledger).sort().join(',') === 'A Customer,B Customer',
    'every Sundry Debtor is a row, and nothing else is -- not the income account, not the bank, not the supplier: '
    + JSON.stringify(cl.rows.map((r) => r.ledger)));
  const c0 = cl.rows.find((r) => r.ledger === 'A Customer');
  assert(c0.ledger === 'A Customer' && c0.group === 'Sundry Debtors', 'the row names the client and the group it hangs under');
  assert(c0.gstin === '19AAAAA0000A1Z5' && c0.pan === 'AAAAA0000A' && c0.state === 'West Bengal'
    && c0.email === 'buyer@example.com', 'what Tally holds about the client travels with it');
  assert(c0.firstSale === '20230510' && c0.lastSale === '20250710',
    'the first and last invoice are named to the day, not the month: ' + c0.firstSale + '..' + c0.lastSale);
  assert(c0.salesByFy['2023-24'] === 140 && c0.salesByFy['2024-25'] === 755 && c0.salesByFy['2025-26'] === 300,
    'each year carries what that year sold: ' + JSON.stringify(c0.salesByFy));
  assert(c0.totalSales === 1195, 'and the total is the years added up, not a separate figure');
  assert(cl.filled.gstin === 1 && cl.filled.phone === 0,
    'the sheet counts what the master actually filled in, so empty columns read as unsynced rather than broken');

  // Asked for a window, "first sale" means the first one IN it -- a date from an
  // earlier year would answer a question nobody asked.
  const recent = await get(base, '/api/clients?fromFy=2025-26');
  assert(recent.fys.join(',') === '2025-26' && recent.rows[0].totalSales === 300,
    'the window decides which years are counted: ' + JSON.stringify(recent.fys));
  assert(recent.rows[0].firstSale === '20250710',
    'and the first sale is the first one inside the window: ' + recent.rows[0].firstSale);


  // ---- the dates survive the 30-minute sync ----------------------------------
  // A partial rebuild folds only the years its payload touched. The first/last sale
  // dates are filed per year for exactly that reason: the touched year is replaced
  // and every other year of that client is left standing. If they were one pair,
  // a sync of the current year would blank the date of every client who last bought
  // in an earlier one -- which is what an unrebuilt fold looks like, and why the
  // readiness is reported rather than left to be guessed at.
  const seenOf = async () => {
    const d = await get(base, '/api/clients?fromFy=2020-21');
    return d.rows.find((r) => r.ledger === 'A Customer') || {};
  };
  const beforeSync = await seenOf();
  assert(beforeSync.firstSale === '20230510' && beforeSync.lastSale === '20250710',
    'the client carries its first and last sale after a full rebuild');

  await post(port, '/ingest', { branch: 'kol', from: '20260401', to: '20270331',
    vouchers: [{ guid: 'y1', date: '20261020', type: 'Sales', no: 'S11',
      ledgers: { 'Sales A/c': 90 }, party_ledgers: { 'A Customer': -90 } }] }, 'tok');
  await settle(base);
  const afterSync = await seenOf();
  assert(afterSync.lastSale === '20261020',
    'a sync of one year moves the last sale forward: ' + afterSync.lastSale);
  assert(afterSync.firstSale === '20230510',
    'and leaves the first sale, which lives in a year the sync never touched: ' + afterSync.firstSale);

  const ready = await get(base, '/api/clients?fromFy=2020-21');
  assert(ready.traded === 1 && ready.filled.lastSale === 1 && ready.datesComplete === true,
    'the endpoint says the dates are complete, so a caller need not count the blanks itself: '
    + JSON.stringify({ traded: ready.traded, lastSale: ready.filled.lastSale, datesComplete: ready.datesComplete }));


  // ---- the CRM's two shapes --------------------------------------------------
  // A customer by calendar month, flat. The fold stores a decade laid end to end and
  // month 0 of a year is APRIL, so the months are named by the endpoint -- re-deriving
  // which slot was which month is exactly where an integration invents an off-by-one.
  const mon = await get(base, '/api/sales/monthly?fromFy=2020-21');
  assert(mon.ok && mon.months[0] === '202304' && mon.months[11] === '202403',
    'the months are named in calendar terms and the year starts in April: '
    + mon.months.slice(0, 12).join(','));
  const mc = mon.rows.find((r) => r.ledger === 'A Customer') || {};
  assert(mc.byMonth && mc.byMonth['202305'] === 100 && mc.byMonth['202610'] === 90,
    'each invoice lands in the calendar month it was raised in: ' + JSON.stringify(mc.byMonth));
  assert(mc.byMonth['202304'] === undefined,
    'a month with no invoice is ABSENT, which is the whole question behind "bought last month but not this"');
  assert(mc.lastSale === '20261020', 'and the row carries the last sale to the day');

  // Line items, with the three traps the endpoint is there to absorb.
  await post(port, '/ingest', { branch: 'kol', from: '20260401', to: '20270331',
    vouchers: [{ guid: 'p1', date: '20261105', type: 'Sales', no: 'S12',
      ledgers: { 'Sales A/c': 1000 },
      // The bank leg is the BIGGER one. A caller unwinding party_ledgers would book
      // this sale against the bank; the fold gives it to the largest Sundry Debtor.
      party_ledgers: { 'A Customer': -1000, 'HDFC Bank': -9000 },
      details: { items: [{ slNo: '1', hsn: '48191000', qty: '1,200', unit: 'Nos',
        rate: '10.00/Nos', amount: 1000,
        description: 'Mono Carton 250gsm\nPrinted 4+0\nBatch : B-12' }] } }] }, 'tok');
  await settle(base);

  const pr = await get(base, '/api/products?from=20260401&to=20270331');
  assert(pr.ok && pr.rows.length === 1 && pr.rows[0].name === 'Mono Carton 250gsm',
    'the product is the FIRST line of Tally’s description block, not the batch and the artwork note too: '
    + JSON.stringify(pr.rows.map((r) => r.name)));
  assert(pr.rows[0].qtyByUnit.Nos === 1200,
    'the quantity is summed per unit, with the thousands comma read: ' + JSON.stringify(pr.rows[0].qtyByUnit));
  assert(pr.rows[0].customers === 1 && pr.counted === 1 && pr.unattributed === 0,
    'the sale is attributed to the debtor, never to the bank leg that was bigger: ' + JSON.stringify(
      { customers: pr.rows[0].customers, counted: pr.counted, unattributed: pr.unattributed }));
  assert(pr.rows[0].hsn === '48191000', 'and the HSN travels with it');

  const byHsn = await get(base, '/api/products?from=20260401&to=20270331&by=hsn');
  assert(byHsn.rows[0].name === '48191000', 'the same window groups by HSN on request');

  const mine = await get(base, '/api/products?from=20260401&to=20270331&party=A Customer');
  assert(mine.counted === 1 && mine.rows.length === 1, 'one customer’s own items can be asked for');
  const nobody = await get(base, '/api/products?from=20260401&to=20270331&party=Someone Else');
  assert(nobody.counted === 0 && nobody.rows.length === 0,
    'and a customer who bought nothing in the window answers empty rather than everything');


  // ---- one row per customer and product, paged ------------------------------
  const item = (desc, hsn, qty, amount) => ({ slNo: '1', description: desc, hsn,
    qty: String(qty), unit: 'Nos', rate: '10.00/Nos', amount });
  await post(port, '/ingest', { branch: 'kol', from: '20260401', to: '20270331', vouchers: [
    // A second customer, two items, so the per-customer list has something to page.
    { guid: 'p2', date: '20261110', type: 'Sales', no: 'S13',
      ledgers: { 'Sales A/c': 7000 }, party_ledgers: { 'B Customer': -7000 },
      details: { items: [item('Duplex Box 300gsm', '48191000', 500, 5000),
        item('Mono Carton 250gsm', '48191000', 200, 2000)] } },
    // A PURCHASE that carries stock items. Not a sale, and the endpoint has to say so
    // rather than call it "unattributed" and leave the reader to wonder.
    { guid: 'p3', date: '20261112', type: 'Purchase', no: 'B9',
      ledgers: { 'Paper Purchase': -4000 }, party_ledgers: { 'Paper Supplier': 4000 },
      details: { items: [item('Art Paper 130gsm', '48102900', 900, -4000)] } },
    // A sale whose only party is a bank: revenue with nobody on the hook for it.
    { guid: 'p4', date: '20261113', type: 'Sales', no: 'S14',
      ledgers: { 'Sales A/c': 1500 }, party_ledgers: { 'HDFC Bank': -1500 },
      details: { items: [item('Mono Carton 250gsm', '48191000', 150, 1500)] } },
  ] }, 'tok');
  await settle(base);

  const perParty = await get(base, '/api/products?from=20260401&to=20270331&by=party');
  const key = (r) => r.ledger + ' / ' + r.name;
  assert(perParty.rows.every((r) => r.ledger),
    'by=party names the customer on every row: ' + JSON.stringify(perParty.rows.map(key)));
  const bDuplex = perParty.rows.find((r) => r.ledger === 'B Customer' && r.name === 'Duplex Box 300gsm');
  assert(bDuplex && bDuplex.value === 5000 && bDuplex.qtyByUnit.Nos === 500,
    'one customer and one item is one row: ' + JSON.stringify(bDuplex));
  assert(perParty.rows.filter((r) => r.name === 'Mono Carton 250gsm').length === 2,
    'the same item bought by two customers is two rows, not one: ' + JSON.stringify(
      perParty.rows.filter((r) => r.name === 'Mono Carton 250gsm').map(key)));
  assert(perParty.rows_total === 3 && perParty.truncated === false && perParty.nextOffset === null,
    'a list that fits says so: ' + JSON.stringify({ t: perParty.rows_total, tr: perParty.truncated }));

  // Paging has to cover the list exactly once -- no row repeated, none dropped.
  const seenKeys = [];
  let off = 0, guard = 0;
  while (guard++ < 10) {
    const pg = await get(base, '/api/products?from=20260401&to=20270331&by=party&limit=1&offset=' + off);
    for (const r of pg.rows) seenKeys.push(key(r));
    if (!pg.truncated) break;
    off = pg.nextOffset;
  }
  assert(seenKeys.length === 3 && new Set(seenKeys).size === 3,
    'paging one row at a time walks the whole list exactly once: ' + seenKeys.join(' | '));

  // Why the rest did not count, separated -- a purchase is not a hole in the revenue,
  // a sale without a debtor might be.
  const prod = await get(base, '/api/products?from=20260401&to=20270331');
  assert(prod.skipped.notASale === 1 && prod.byTypeNotCounted.Purchase === 1,
    'a purchase with stock items is reported as not a sale, by its voucher type: '
    + JSON.stringify({ skipped: prod.skipped, byType: prod.byTypeNotCounted }));
  assert(prod.skipped.saleWithoutDebtor === 1 && prod.saleWithoutDebtorSample.length === 1,
    'and a sale with no debtor is counted apart: ' + JSON.stringify(prod.skipped));
  assert(prod.saleWithoutDebtorSample[0].no === 'S14' && prod.saleWithoutDebtorSample[0].type === 'Sales'
    && prod.saleWithoutDebtorSample[0].revenue === 1500,
    'named by voucher number, type and the revenue at stake, so it can be looked up: '
    + JSON.stringify(prod.saleWithoutDebtorSample[0]));

  const tooWide = await get(base, '/api/products?from=20200401&to=20270331');
  assert(tooWide.ok === false && /400/.test(tooWide.error),
    'a window wider than a financial year is refused with the limit named: ' + tooWide.error);

  // ---- cancelled and optional vouchers count nowhere -------------------------
  // Tally's own two marks. A cancelled voucher carries no postings, but an OPTIONAL
  // one is a draft that looks exactly like a sale in the Day Book -- counting it would
  // inflate revenue here and nowhere else, which is the hardest disagreement to find.
  const totalOf = async (who) => {
    const d = await get(base, '/api/clients?fromFy=2020-21&measure=gross');
    return ((d.rows.find((r) => r.ledger === who) || {}).totalSales) || 0;
  };
  const beforeDrafts = await totalOf('B Customer');
  await post(port, '/ingest', { branch: 'kol', from: '20260401', to: '20270331', vouchers: [
    { guid: 'p5', date: '20261120', type: 'Sales', no: 'S15', cancelled: true,
      ledgers: { 'Sales A/c': 50000 }, party_ledgers: { 'B Customer': -50000 },
      details: { items: [item('Duplex Box 300gsm', '48191000', 5000, 50000)] } },
    { guid: 'p6', date: '20261121', type: 'Sales', no: 'S16', optional: true,
      ledgers: { 'Sales A/c': 60000 }, party_ledgers: { 'B Customer': -60000 },
      details: { items: [item('Duplex Box 300gsm', '48191000', 6000, 60000)] } },
  ] }, 'tok');
  await settle(base);

  assert((await totalOf('B Customer')) === beforeDrafts,
    'a cancelled and an optional invoice change no customer total: ' + beforeDrafts);
  const afterDrafts = await get(base, '/api/products?from=20260401&to=20270331&by=party');
  const bDuplex2 = afterDrafts.rows.find((r) => r.ledger === 'B Customer' && r.name === 'Duplex Box 300gsm');
  assert(bDuplex2.value === 5000 && bDuplex2.qtyByUnit.Nos === 500,
    'nor any product figure: ' + JSON.stringify(bDuplex2));
  const ds = await get(base, '/api/dataset?from=20260401&to=20270331&branch=kol');
  const dsNos = (ds.branches ? ds.branches.kol.vouchers : ds.vouchers).map((v) => v.no);
  assert(!dsNos.includes('S15') && !dsNos.includes('S16') && dsNos.includes('S13'),
    'and neither reaches the dashboards: ' + dsNos.join(','));

  // The one direction that must NOT happen: an optional voucher confirmed later is an
  // ordinary sale, so the flag has to come OFF when Tally stops reporting it.
  await post(port, '/ingest', { branch: 'kol', from: '20260401', to: '20270331', vouchers: [
    { guid: 'p6', date: '20261121', type: 'Sales', no: 'S16',
      ledgers: { 'Sales A/c': 60000 }, party_ledgers: { 'B Customer': -60000 },
      details: { items: [item('Duplex Box 300gsm', '48191000', 6000, 60000)] } },
  ] }, 'tok');
  await settle(base);
  assert((await totalOf('B Customer')) === beforeDrafts + 60000,
    'a draft confirmed in Tally counts from then on, rather than staying excluded for ever: '
    + (await totalOf('B Customer')));

  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== year-on-year API passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
