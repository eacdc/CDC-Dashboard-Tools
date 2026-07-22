# CDC Dashboard Tools — CHANGELOG

## v2.1 (pipeline) — July 2026 — Full voucher detail + printable invoice/journal PDF

Branch `claude/voucher-details-completeness-ne9ejq`. Captures the *whole* voucher
(not just ledger amounts) and adds a Tally-style printable view with a **Download
PDF** button, so a single voucher can be reprinted exactly like the Tally invoice /
journal it came from. Fully backward compatible — the dashboards' data path is
unchanged.

### Extractor (`pipeline/TallyToJson.ps1`)
- `ConvertTo-VoucherObject` now also harvests a **`details`** object from the Day
  Book XML (which already contained it): party GSTIN + mailing name + multi-line
  address + state + place of supply; consignee block; invoice metadata (supplier's
  ref, buyer's order no/date, delivery note, despatch info, destination, **e-way
  bill no**, vehicle no, terms of payment/delivery, IRN/Ack); **narration**; and
  **line items** (`ALLINVENTORYENTRIES.LIST`) with stock item, **HSN/SAC**, qty +
  unit, rate, discount, amount.
- Inventory + narration read from confident tags; header metadata is best-effort
  (Tally's tag names vary by version) and degrades to `""`/`[]` when absent — a
  bare journal simply carries empty extras. JSON depth bumped so nested items
  serialize.

### API (`server/`)
- `ingest.js`: `cleanVoucher` now persists `details` via a new `cleanDetails`
  whitelist (scalars + address lines + item fields), so a rogue payload can't bloat
  the store. Vouchers with nothing extra store no `details` key.
- `GET /api/voucher?branch=&id=<guid>` (or `&no=&type=&date=`) — one voucher with
  full `details`. `GET /api/dataset` now **excludes** `details` (dashboards stay lean).
- New `server/test_voucher_details.js` (`npm run test:voucher`): details round-trip,
  sanitizer, dataset stripping, and the `/api/voucher` id/no/404 paths — all green.

### Printable voucher (`voucher/index.html`, served at `/voucher/`)
- Renders a stored voucher as a **Tax Invoice** (header, e-invoice IRN/Ack, meta
  grid, consignee/buyer blocks, HSN line-item table, HSN-wise tax summary, amount in
  words, declaration + signatory) or a **Journal Voucher** (Dr/Cr particulars +
  narration). **Download PDF** = browser print-to-PDF (no external libs → CSP-safe,
  A4, pixel-accurate).
- HSN-wise CGST/SGST/IGST is computed client-side from line items + GST ledger legs
  (Tally's export has no per-HSN breakup). Verified against the two reference PDFs
  (Journal #443 and invoice CDC/2662/26-27) — totals and per-HSN tax reproduce exactly.
- Bundled samples for demo without a DB: `/voucher/?demo=invoice`, `/voucher/?demo=journal`.

---

## v2.0 (pipeline) — July 2026 — Tally → MongoDB automation (testing copy)

Branch `claude/cdc-dashboard-automation-it2ecc`. Adds an automated data pipeline so
the Consolidated and Projected dashboards no longer need manual 4-file uploads.
Existing upload flow is untouched and stays as a fallback.

### Pipeline (`pipeline/TallyToJson.ps1`)
- JSON sibling of `TallyCSV.ps1`: same Tally HTTP-XML gateway calls, but emits the
  **two dashboard-native JSON files** (`<branch>_Master.json` hierarchy,
  `<branch>_Transactions.json` vouchers) instead of 7 CSVs.
- Ledger/party split derived from the group hierarchy — a line is `party_ledgers`
  if its ancestry hits Sundry Debtor/Creditor, Bank, Cash, Bank OD or Branch;
  else `ledgers`. Verified to reproduce the reference `amd` export at **99.977%**
  (the 5 diffs are ambiguous bank-as-party edge lines that change no total).
- Raw Tally signs and `yyyyMMdd` dates preserved. Captures voucher GUID for
  idempotent loads. Optional `-IngestUrl` POST; otherwise writes files for the
  offline loader (Tally RDP box may have no internet).

### API (`server/`, Node + Express + MongoDB)
- `POST /ingest` (idempotent upsert on branch+guid), `GET /api/dataset?from&to&branch`,
  `GET /api/meta`, `/health`. Serves the static dashboards too — one Render service.
- `server/loader.js` pushes the .ps1's JSON files to Atlas from any machine (offline case).
- Content-hash fallback key prevents two distinct same-`(date,type,no)` vouchers
  (a real quirk found in the sample: two Purchase #1954) from colliding.

### Dashboards
- Consolidated (**v1.13.0**) and Projected (**v1.11.0**) gain a **"MongoDB (auto)"**
  source toggle with a **date-range picker (default: 1 Apr current FY → today)**.
  Both feed the *same* `processData` / `buildProjection` — no logic forked.
- Verified end-to-end in a real browser against the `amd` sample: consolidated P&L
  (₹51.06 Cr rev) + cashflow, and projected cashflow both render from the API.

### Deploy
- `render.yaml` blueprint. Secrets (`MONGODB_URI`, `INGEST_TOKEN`) via env, never committed.

---

## v1.7 — June 2026

### Projected Cashflow — IE projection landed at ~2.5 Cr/mo

End state of the IE projection logic after iterating through v1.2 → v1.7:

- **Skip Purchase vouchers** — those bills flow through the creditor outflow cycle, double-count guard (from v1.2).
- **Year-aware monthly bins** — `ieByMonth['YYYYMM']` so multi-FY data doesn't collide (from v1.1).
- **Signed sum** — Cr reversals net off Dr expense within the month.
- **Sign-flip fix** — Tally JSON convention has Dr expense entries as negative; negate before clamping at 0 (from v1.4).
- **Last 3 complete calendar months** — March/Apr/May 2026 when today = Jun 2026 (from v1.1).
- **Non-cash ledger blacklist** — exclude IE legs whose ledger name matches `depreciation`, `provision`, `amortization`, `write off`, `bad debt`. Caught the March 2026 10.45 Cr year-end spike (depreciation + gratuity + audit fee provisions).
- **Diagnostic dump** — `window.__ieDebug` exposes per-month bins, voucher type counts, sample hits, sample skips with reasons, and the full non-cash ledger blacklist for verification.

Result: ~2.5 Cr/month direct-paid IE, matching the historical Apr 2025 – Feb 2026 pattern of 1.5–2.5 Cr/month after excluding the year-end book-closing entries.

### Hosting / deploy hygiene

- **Cloudflare no-store** — `_headers` file added at repo root tells Render's CDN (Cloudflare) not to cache HTML. Fixes the 5-minute stale window after a deploy without needing `?nocache=` query strings.
- **Version badge on all three dashboards** — `v1.x · Last updated dd-mmm-yyyy` green pill on the upload screen of projected, consolidated, and dashboard. Browser-tab title also stamped with the version. Lets the user confirm the live page matches the latest deploy at a glance.

---

## v1.2 — June 2026

### Projected Cashflow — Loosened IE creditor filter

v1.1 excluded any IE voucher that had a Sundry Creditor on either side. In practice this turned out to be too aggressive — in CDC's books almost every IE voucher carries a creditor leg (the payee in a Payment voucher is often classified as a Sundry Creditor), so the filter zeroed out the entire IE projection.

The clean double-count only happens for **Purchase vouchers** — those always create a Sundry Creditor bill that will be settled via the creditor outflow cycle. For all other voucher types (Payment, Cash Voucher, Journal, etc.) the creditor leg is the payee being paid right now, not a future bill, so IE should count.

Filter is now simply `vt !== 'Purchase'`. IE projection should reflect actual salary, electricity, bank charges, interest, rent and similar direct cash payments.

---

## v1.1 — June 2026

### Repo Structure

Removed duplicate root files (`cdc-projected-cf.html`, `cdc-consolidated.html`, `cdc-dashboard-v2.html`). Render serves from `projected/index.html`, `consolidated/index.html`, `dashboard/index.html`, and those are now the single source of truth. Future edits go directly to the subdirectory files — no manual sync step.

### Projected Cashflow (`projected/index.html`)

#### Indirect Expense Projection — Three Combined Fixes
The IE rolling average had three independent bugs that together inflated the projected outflow well above the actual run rate (e.g. 7.88 Cr projected vs ~3 Cr actual monthly):

1. **Year-blind binning** — `mk()` indexed by month only (`(m-4+12)%12`), so Mar 2025 and Mar 2026 collapsed into the same bucket. With multi-FY data (Apr 2025 – Jun 2026), the loop scanning backward from March would pick FY 25-26 Q4 numbers (bonus/gratuity/year-end spike) and never reach the recent FY 26-27 months. Replaced `ieM[0..11]` with `ieByMonth['YYYYMM']`.

2. **`Math.abs` on every leg** — A Cr reversal entry (-50k) was being added as +50k, treating reversals as additional expense. Switched to signed sum; reversals now correctly net off the original Dr entry within the same month.

3. **Sundry-creditor double-count** — Indirect expense bills booked via Purchase or Journal vouchers with a Sundry Creditor leg (sundry spares, repairs, professional fees etc.) were counted both in the creditor outflow projection and again in IE. Skip IE accumulation when any Sundry Creditor is on either `party_ledgers` or `ledgers`. IE now holds only cash-paid-direct expenses (salary, electricity, interest, bank charges, rent, journal accruals without a creditor leg).

The averaging logic also changed: instead of scanning month bins backward from March, we now pick the 3 calendar months immediately preceding the current (partial) month, so the projection reflects the real recent run rate.

---

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
