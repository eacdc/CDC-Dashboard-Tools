// Reading Tally's own ledger export.
//
// /diag/ledger.html puts one ledger's vouchers beside the same ledger exported out of
// Tally, and names the ones that differ. Everything downstream of that rests on reading
// the export right, and the export is the one input nobody here controls: Tally moves
// its columns between versions, prints the closing balance on the opposite side, and
// pads the sheet with a letterhead and grand totals that are not vouchers.
//
// So the parser is lifted out of the page BY REGEX and run here, the same way
// plEngine.js lifts the dashboard's accounting -- one implementation, tested where it
// lives. Renaming readExport in the page fails this suite by name, which is the point.
//
// The fixture is built with the same vendored SheetJS the page uses, in the shape a real
// export has -- proved against one: a 329-row Kolkata ledger whose opening plus movement
// came back equal to the closing balance Tally printed, to the rupee.
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '..', 'vendor', 'xlsx.full.min.js'));

let fails = 0;
const assert = (cond, msg) => { if (cond) console.log('ok  - ' + msg); else { fails++; console.log('FAIL: ' + msg); } };

// ---- lift the parser out of the page ---------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'diag', 'ledger.html'), 'utf8');
const WANTED = ['d8', 'num', 'readExport'];
let code = '';
for (const fn of WANTED) {
  const m = src.match(new RegExp('\\n  function ' + fn + '\\([\\s\\S]*?\\n  \\}\\n'));
  if (!m) throw new Error(`diag/ledger.html no longer defines ${fn}() -- update WANTED here, do not copy the function`);
  code += m[0].replace(/^ {2}/gm, '') + '\n';
}
// eslint-disable-next-line no-eval
eval(code);

// ---- a sheet shaped like Tally's export -------------------------------------
const sheet = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const ws = XLSX.read(buf, { type: 'buffer', cellDates: true }).Sheets.Sheet1;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
};

const LETTERHEAD = [
  ['CDC PRINTERS PVT LTD', '', '', '', '', '', ''],
  ['45 Radhanath Choudhury Road', '', '', '', '', '', ''],
  ['A Customer Pvt Ltd', '', '', '', '', '', ''],
  ['Ledger Account', '', '', '', '', '', ''],
  ['', '', '', '', '', '', ''],
  ['1-Apr-25 to 8-Sep-26', '', '', '', '', '', ''],
  ['Date', 'Particulars', '', 'Vch Type', 'Vch No.', 'Debit', 'Credit'],
];
const BODY = [
  [new Date(2025, 3, 1), 'To', 'Opening Balance', '', '', 6756324, ''],
  [new Date(2025, 3, 4), 'By', 'Citi Bank, (Kolkata)', 'Bank Receipt', 'BR/43/25-26', '', 453583],
  [new Date(2025, 3, 11), 'To', 'Sale - Packaging', 'Sales', 'CDC/264/25-26', 240240, ''],
  [new Date(2026, 8, 8), 'To', 'Sale - Packaging', 'Sales', 'CDC/4220/26-27', 196598, ''],
];
const TAIL = [
  [7193162, '', '', '', '', '', 453583],
  ['', 'By', 'Closing Balance', '', '', '', 6739579],
  [7193162, '', '', '', '', '', 7193162],
];

const r = readExport(sheet([...LETTERHEAD, ...BODY, ...TAIL]));

assert(r.from === '20250401' && r.to === '20260908',
  "the period comes off the letterhead, so the comparison cannot be run over a different window than the export: "
  + JSON.stringify([r.from, r.to]));
assert(r.opening === 6756324,
  'the opening balance is read, because it is the half no amount of adding vouchers up recovers');
assert(r.closing === 6739579,
  'the closing balance is flipped: Tally prints it as the BALANCING entry, on the opposite side, and taken at '
  + 'face value a customer who owes us money reads as owing nothing: ' + r.closing);
assert(r.rows.length === 3,
  'the opening, closing and grand-total lines are not vouchers and are not counted as any: ' + r.rows.length);
const move = r.rows.reduce((a, v) => a + v.amount, 0);
assert(Math.round((r.opening + move) * 100) / 100 === r.closing,
  'and what is left reconciles -- opening plus movement IS the closing balance Tally printed, which is the '
  + 'only proof that nothing was dropped or double-read: ' + JSON.stringify([r.opening, move, r.closing]));
assert(r.rows[0].amount === -453583 && r.rows[1].amount === 240240,
  'a receipt is negative and a sale positive, on the same Dr-positive scale the API answers on');
assert(r.rows[0].no === 'BR/43/25-26' && r.rows[0].type === 'Bank Receipt',
  'each row keeps its voucher number, which is the only thing both sides carry to match on');

// Tally moves its columns between versions, and a fixed index is how a parser starts
// reading the credit column as the debit one. The header words decide.
const MOVED = [
  ['1-Apr-25 to 8-Sep-26', '', '', '', ''],
  ['Vch No.', 'Date', 'Particulars', 'Credit', 'Debit'],
  ['BR/43/25-26', new Date(2025, 3, 4), 'By Citi Bank', 453583, ''],
];
const rm = readExport(sheet(MOVED));
assert(rm.rows.length === 1 && rm.rows[0].amount === -453583 && rm.rows[0].no === 'BR/43/25-26',
  'the columns are found by their header words, not by position, because Tally moves them between versions: '
  + JSON.stringify(rm.rows[0]));
assert(rm.rows[0].particulars === 'By Citi Bank',
  'and a layout that puts an amount where the particulars continue does not staple the figure onto the description: '
  + JSON.stringify(rm.rows[0].particulars));

// A file that is not the ledger report at all should say so rather than compare nothing
// and report every voucher as ours alone.
let threw = '';
try { readExport(sheet([['Some other report'], ['a', 'b']])); } catch (e) { threw = e.message; }
assert(/Date\/Debit\/Credit/.test(threw),
  'a file with no Date/Debit/Credit header is refused by name, not silently compared against nothing');

// Dates arrive as real dates from the spreadsheet, but a CSV opened as text gives
// strings -- both, and both forms Tally writes.
assert(d8(new Date(2026, 8, 8)) === '20260908', 'a spreadsheet date is read');
assert(d8('2025-04-01 00:00:00') === '20250401', 'and so is the timestamp form a CSV carries');
assert(d8('8-Sep-26') === '20260908' && d8('1-Apr-25') === '20250401',
  "and Tally's own day-month-year spelling, which is what the letterhead uses");
assert(num('12,34,567.10') === 1234567.1 && num('') === 0,
  'lakh-grouped amounts are numbers, and an empty cell is zero rather than NaN poisoning a total');

console.log(fails ? `\n${fails} check(s) FAILED` : "\n== Tally's ledger export is read correctly ==");
process.exit(fails ? 1 : 0);
