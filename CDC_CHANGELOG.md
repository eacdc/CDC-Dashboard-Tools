# CDC Dashboard Tools — CHANGELOG

## v1.0 — March 2026

### Projected Cashflow (`cdc-projected-cf.html`)

#### Features Added
- **Bill-wise outstanding** — Uses Tally Bills Receivable/Payable CSVs as opening balance with individual invoice dates
- **Combined FIFO** — Opening bills + this year's invoices merged chronologically, receipts matched oldest-first
- **Timeline FIFO** — Handles advance payments (payment before invoice) by accumulating advance credit
- **Avg days cascade** — Own → Group → Company fallback with colored badges
- **360-day cutoff** — Excludes parties with avg >360d or no payment history
- **Stale bill exclusion** — Individual bills >360d old excluded if party has weak payment pattern
- **Editable days** — Click any party's day badge to override, instant recalculation
- **Exclude/include toggle** — Per-party exclusion with strikethrough display
- **Full hierarchy grouping** — Collapsible tree matching Tally's Sundry Debtors/Creditors structure
- **As-of date** — Set to any date to backtest predictions; vouchers after that date excluded
- **Indirect expenses** — Rolling 3-month average projected forward
- **Excel export** — Respects group open/closed state, shows excluded parties separately
- **Save/Load overrides** — Download overrides as JSON, reload next session
- **localStorage backup** — Browser auto-saves overrides (per-device)
- **Clear overrides** — One-click reset of all day changes and exclusions

#### Receipt Sources (Debtor)
- Bank Receipt / Receipt vouchers
- PCFC Journals (loan Cr + debtor Dr in party_ledgers)
- Branch Settlement Journals (debtor Dr + branch Cr, no loan)
- Credit Notes (debtor Dr = cancels invoice)

#### Payment Sources (Creditor)
- Bank Payment / Payment / Cash Payment vouchers
- Creditor Journals (creditor Cr in party_ledgers = agent payments)
- Creditor Journals (creditor Cr in ledgers field)
- Debit Notes (creditor Cr = invoice cancellation)

#### Bug Fixes
- **Manugraph advance** — Negative amounts in bills CSV treated as advances/payments, not invoices
- **Dr suffix parsing** — "-54602328.00 Dr" correctly parsed as advance of 5.46 Cr
- **Eco Jute Credit Notes** — 31L of Credit Notes were not entering FIFO, inflating outstanding
- **Insight Print advance** — Payment before invoice now creates advance credit in timeline FIFO
- **Airlines agent journals** — Creditor Cr (negative) in journals = payment closure, not Dr
- **Debit Note sign** — Creditor is Cr (negative) in Debit Notes, not Dr

---

### Consolidated Dashboard (`cdc-consolidated.html`)

#### Features Added
- **4-file upload** — Kolkata + Ahmedabad hierarchy and voucher JSONs
- **Auto inter-branch elimination** — Detects Branch/Divisions group, eliminates from P&L and Cashflow
- **Ahmedabad voucher type handling** — Cash Voucher, Receipt/Payment mapped correctly

#### Cashflow (Approach G — Daybook Simulation)
- Direction from voucher type, not sign
- PCFC Journal handling (loan Cr + debtor Dr)
- Branch Settlement Journals (debtor Dr + branch Cr)
- Creditor Journal payments (creditor Cr)
- Debit Notes (creditor Cr)

#### P&L Fixes
- **Removed Math.abs()** — Raw signed values preserved per month
- **Agency Comm 27.5%** — Was showing 12.16 Cr (double-counted via abs), now correctly nets to 0
- **GP/NP formula** — Changed from `rev - purch - exp` to `rev + purch + exp` (signs already correct)
- **Journal P&L entries** — All voucher types processed including Journals with P&L accounts

#### Excel Export
- Respects expanded/collapsed group state via expandRegistry
- Pass open state directly to export function (not relying on stale global)

---

### Single Branch Dashboard (`cdc-dashboard-v2.html`)

#### Same fixes as Consolidated
- Removed Math.abs() from P&L
- Fixed GP/NP formula
- Excel export respects group state

---

## Architecture Decisions

### Why bill-wise outstanding instead of flat opening balance?
- Flat OB (one amount per party dated 1 Apr) gives no invoice-level granularity
- Old invoices (2021, 2022) with any avg days < 365 all project to current month
- Bill-wise gives exact invoice dates → FIFO produces accurate payment day calculations
- Bills overdue >360d can be individually excluded without losing recent bills

### Why timeline FIFO instead of separate invoice/receipt matching?
- Handles advance payments (payment arrives before invoice)
- Advances accumulate as credit, absorbed by future invoices
- Prevents phantom outstanding when payments precede invoices (Insight Print, Manugraph)

### Why not use Tally's "Overdue by days" column?
- We calculate our own avg days from actual receipt patterns
- Tally's overdue is based on due date, not actual payment behavior
- Our FIFO-derived avg is more predictive of future behavior

### Why multiple receipt sources?
- CDC's export business routes payments through PCFC loans (bank receipt → loan, journal → debtor)
- Ahmedabad clients pay to Kolkata bank (branch settlement journals)
- Travel agent pays airlines via multi-party journals
- Without capturing all sources, debtor/creditor outstanding is inflated
