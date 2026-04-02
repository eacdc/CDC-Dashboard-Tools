# CDC Financial Dashboard Tools — Logic Reference
## Version: March 2026

---

## TOOL 1: Single Branch Dashboard (`cdc-dashboard-v2.html`)
**Inputs:** hierarchy.json, vouchers.json, stock_template.csv (optional)

### P&L Processing
- Processes ALL voucher types (no type filter)
- Scans both `ledgers` and `party_ledgers` fields
- Classifies via PL_CATS: Sales Accounts + Direct Incomes + Indirect Incomes → revenue; Purchase Accounts → purchase; Direct/Indirect Expenses → expense
- **No Math.abs()** — raw signed values preserved per month
- Sign convention: Income = positive (Dr in Tally), Expenses = negative (Cr in Tally)
- GP = revM + purchM + dirExpM + stockM (all signs already correct)
- NP = GP + indExpM

### Cashflow Processing (Approach G — Daybook Simulation)
- Cash voucher types: Bank Receipt, Receipt, Bank Payments, Bank Payment, Cash Paynent, Cash Payment, Cash Voucher, Payment, Contra
- Scans BOTH party_ledgers AND ledgers fields
- Skips Bank Accounts and Bank OD/OCC entries (counter-entries)
- Direction from voucher type, not sign:
  - Receipt: raw amount (already positive)
  - Payment: flip sign (*-1)
  - Contra: flip sign, then check: positive → inflow, negative → outflow
- **PCFC Journal handling:** Journal with Loan Cr (negative in ledgers) → Loan outflow (repayment) + Debtor inflow (receipt)
- **Branch Settlement Journals:** Journal with Debtor Dr + Branch Cr → Debtor inflow (client paid via other branch)

---

## TOOL 2: Consolidated Dashboard (`cdc-consolidated.html`)
**Inputs:** kol_hierarchy.json, kol_vouchers.json, ahm_hierarchy.json, ahm_vouchers.json, stock_template.csv (optional)

### Hierarchy Merging
- Kolkata hierarchy is base; Ahmedabad-only groups added
- 218 overlapping ledgers merge naturally (same monthly arrays summed)
- 13 Ahmedabad-only groups added

### Inter-Branch Elimination
- Auto-detects via `Branch / Divisions` group in hierarchy
- Inter-branch ledgers: CDC Printers (Ahmedabad), CDC Printers (Kolkata), Citi Bank branches, etc.
- Eliminated from both P&L and Cashflow

### Voucher Type Differences
- Ahmedabad uses `Cash Voucher` instead of `Cash Paynent`
- Ahmedabad uses `Receipt`/`Payment` instead of `Bank Receipt`/`Bank Payments`
- Both handled in CASH_VCH mapping

### P&L — Same as Tool 1 plus:
- Journal entries with P&L accounts fully captured (agency commission, salary accruals, etc.)
- No Math.abs() — net values per month prevent double-counting of reversed entries
- Agency Comm 27.5%: Export Sale books +8.09 Cr, Journal reverses -8.09 Cr → net 0

### Cashflow — Same as Tool 1 plus:
- PCFC Journals (loan Cr + debtor Dr)
- Branch Settlement Journals (debtor Dr + branch Cr, no loan)
- **Creditor Journal payments** (creditor Cr/negative in Journal = agent payments, salary, utilities)
- **Debit Notes** (creditor Cr/negative = payment/cancellation)
- Credit Notes are NOT cashflow events (no cash movement)

### Excel Export
- Respects expanded/collapsed group state via expandRegistry
- Indentation reflects hierarchy depth
- Collapsed groups show only total row

---

## TOOL 3: Projected Cashflow (`cdc-projected-cf.html`)
**Inputs:** 4 JSON files + Bills Receivable CSV + Bills Payable CSV (Kol + Ahm optional) + As-of Date

### Bill-Wise CSV Parsing
- Format: Date, Ref. No., Party's Name, Pending Amount, Due on, Overdue by days
- **Negative amounts = advances/payments** (treated as receipts in FIFO)
- **Dr suffix stripped** (e.g., "-54602328.00 Dr" → advance of 5.46 Cr)
- Opening bills enter FIFO as invoices; negative entries enter as receipts

### Outstanding Calculation
- **Outstanding = Opening Bills + This Year's Invoices − Receipts** (from vouchers)
- Combined FIFO: opening bills + year invoices sorted chronologically, receipts matched against oldest first

### Receipt Sources (Debtor)
1. Bank Receipt / Receipt vouchers (direct)
2. PCFC Journals (loan Cr + debtor Dr)
3. Branch Settlement Journals (debtor Dr + branch Cr)
4. **Credit Notes** (debtor Dr/positive = cancels invoice → treated as receipt)

### Payment Sources (Creditor)
1. Bank Payment / Payment vouchers (direct)
2. Creditor Journals (creditor Cr/negative = agent payments, salary, utilities)
3. Debit Notes (creditor Cr/negative = invoice cancellation)

### Invoice Sources (Debtor)
1. Sales / Export Sale vouchers
2. Debit Notes on debtors (debtor Cr/negative = additional charge)

### FIFO Timeline Algorithm
- Events (invoices + receipts) merged and sorted by date
- Invoices before receipts on same date
- **Advance handling:** receipt with no invoice to match → accumulates as advance credit
- When invoice arrives, advance absorbs it first (0 days payment cycle)
- Receipt matches against oldest unmatched invoice in queue
- Days-to-payment capped at 730 for avg calculation; only ≤360d matches count for average

### Average Days Cascade
1. **Own** — party's FIFO-matched avg days (blue badge)
2. **Group** — average of parties in same Tally group (amber badge)
3. **Company** — average across all parties (purple badge)
4. **Override** — user-set value (green badge)

### Exclusion Rules
- Party avg days > 360 → excluded (reason: over_360)
- No payment history at any level → excluded (reason: no_history)
- Individual bills > 360 days old AND party doesn't have strong own payment pattern → bill excluded
- All remaining bills stale → party excluded (reason: all_bills_stale)

### Projection
- Each unpaid bill: bill_date + avg_days = projected_receipt_date
- If projected date < as-of date → set to as-of date (overdue, expect this month)
- 3 months forward from as-of date
- Indirect expenses: rolling 3-month average

### As-Of Date
- Vouchers after as-of date are excluded from processing
- Projection months calculated from as-of date
- Enables backtesting: "what would March prediction have been?"

### Interactive Features
- **Editable days per party** — click badge, type new value, Enter → recalculates instantly
- **Exclude/include toggle** — click ✕/− button per party
- **Full hierarchy grouping** — collapsible tree matching Tally structure
- **50K minimum filter** — small parties hidden
- **Search** — filters across all groups
- **Excel export** — respects group open/closed state, shows excluded parties separately

---

## KEY SIGN CONVENTIONS (Tally JSON)

| Context | Positive (Dr) | Negative (Cr) |
|---------|--------------|---------------|
| Sales voucher, party_ledgers | — | Debtor (invoice) |
| Sales voucher, ledgers | Income account | — |
| Purchase voucher, party_ledgers | — | Creditor (invoice) |
| Purchase voucher, ledgers | — | Expense/asset |
| Receipt voucher, party_ledgers | Debtor (receipt) | Bank (counter) |
| Payment voucher, party_ledgers | — | Creditor (payment) |
| Journal, party_ledgers | Varies | Varies |
| Credit Note, party_ledgers | Debtor (cancellation) | — |
| Debit Note, party_ledgers | — | Creditor (cancellation) |

## CRITICAL FIXES HISTORY

1. **Cashflow sign convention** — Receipt raw, Payment *-1, Contra *-1 then check sign
2. **PCFC loan routing** — Journal with Loan Cr + Debtor Dr = client payment closing loan
3. **Branch settlement** — Journal with Debtor Dr + Branch Cr = inter-branch client payment
4. **Creditor journal payments** — Journal with Creditor Cr = agent payment (airlines, utilities)
5. **Debit Note creditor sign** — Creditor is Cr (negative), not Dr
6. **Opening balance sign** — negative Dr under creditors = advance (parseFloat + abs + Dr/Cr suffix)
7. **Math.abs() removal** — P&L monthly values keep raw signs, prevents double-counting of reversed entries
8. **GP/NP formula** — Changed from rev-purch-exp to rev+purch+exp (signs already correct)
9. **Advance payment FIFO** — Timeline-based: payment before invoice creates advance credit
10. **Credit Notes as receipts** — Debtor Dr in Credit Note = cancels invoice, reduces outstanding
11. **Bill-wise outstanding** — Opening bills with individual dates enable accurate FIFO matching
12. **360-day cutoff** — Excludes stale debts from projection
13. **As-of date** — Enables backtesting predictions vs actuals
