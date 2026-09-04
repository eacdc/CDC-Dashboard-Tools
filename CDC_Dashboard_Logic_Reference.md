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
- **Bill-wise first, then FIFO fallback** (two-pass `combinedFIFO`):
  - **Pass 1 (bill-wise):** a receipt that names the bill it settles (Tally `Agst Ref`
    in `BILLALLOCATIONS`) is applied to THAT exact bill, honouring the Tally posting.
  - **Pass 2 (date FIFO):** leftover money (no bill reference, `On Account`/`Advance`,
    or an unknown reference) is matched oldest-bill-first, as before.
- **Bill references:** invoices seed the bill map by their `New Ref` name; opening bills
  by their CSV `Ref. No.`; receipts settle by their `Agst Ref` name. Shared namespace
  (e.g. `CDC/7037/25-26`).
- **Allocation signs matter.** Tally stores every allocation line signed (`-ve` Dr /
  `+ve` Cr) and one voucher can carry lines both ways for the same ledger — a receipt
  that also puts value back on a bill (return, adjustment, bill-to-bill transfer). Each
  line is read relative to the posting's own direction: **+ve settles/opens, -ve puts
  value back on that bill**. Lines sharing a reference are netted. Verified against a
  real Day Book: the signed total of a posting's allocations equals that posting's net
  amount exactly. If it ever exceeds the net, the posting is handed to date FIFO rather
  than guessed at, and counted in `window.__cdcAllocDiag.unreconciledToFIFO`.
- **Backward compatible:** vouchers synced before bill capture carry no `bills`, so every
  receipt falls through to Pass 2 — identical to the previous pure-FIFO engine.
- Requires the pipeline (`TallyToJson.ps1` → `Collect-BillAllocs`) and API
  (`ingest.js` whitelist) to carry the `bills:[{ledger,ref,type,amount}]` voucher field.
- **Bill-wise / FIFO toggle** (portal top bar, Projected tab): `fifo` makes the engine
  ignore every bill reference, reproducing the pre-bill-wise behaviour on the same data
  — for comparison, not as a different truth. It covers the whole Projected app, is
  remembered per browser, and is stamped into the aging exports (`_BillWise` / `_FIFO`).
- **⇄ Compare** (same bar) runs both engines and downloads a report of what moved. The
  invariant it checks: allocation moves money **between** a party's bills, so every
  party's total outstanding must be identical in both modes. Only which bills stay
  open, the ageing buckets and the payment cycle may differ.

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

## WHAT CAN DELETE A VOUCHER

Exactly three code paths remove vouchers. Worth knowing, because a week of May 2026
was lost to the second one.

1. **`/admin/reset`** (`-Reset` / `-ResetAll`, `loader.js --reset`) — a person asks for
   it. `-ResetAll` is the ONLY path that can reach a back-filled year.
2. **Incremental sync, replace-by-date** — a changed date is deleted, then the fresh
   pull is inserted. If the pull came back empty the day was simply gone. **Guarded:**
   only dates the payload actually carries vouchers for are replaced; an empty
   replacement leaves the day alone and reports `skippedEmptyDates` + a warning. A day
   genuinely emptied in Tally is still cleared by the reconcile below.
3. **Incremental sync, deletion reconcile** — removes vouchers whose GUID Tally no
   longer lists, **scoped to `scanFrom..scanTo`**. **Guarded:** the incoming list must
   overlap what is stored. A list from the wrong company overlaps ~0% and would delete
   the window wholesale; anything that would clear more than half of ≥50 stored
   vouchers is refused with `reconcileRefused` and a warning.

**Back-filled years cannot be touched automatically.** Both sync deletes work inside
the scan window, which starts at `run_daily.ps1 -SyncFromDate` (default `20250401`).
Only an explicit `-ResetAll` reaches further back.

Covered by `npm run test:sync`.

## YEAR ON YEAR (landing-page summary)

Every financial year side by side, before anything is loaded, with a year opening
into its twelve months. The dashboards compute these lines in the browser from ONE
year's vouchers; a decade cannot travel to a browser, so `server/yoySummary.js` folds
them server-side in a single streaming pass and stores a few thousand numbers.

**The figures must equal the dashboard's.** They are not re-derived: `plEngine.js`
lifts the portal's own `classify` / `getChain` / `monthKey` / `CASH_VCH` out of
`portal/index.html` and runs them in Node, so a ledger lands in the same bucket on
both sides, and renaming one of those functions fails loudly at startup instead of
drifting the numbers apart. `npm run test:yoy` then runs the same vouchers through
`processData` in Chromium and through the fold, comparing every monthly figure across
3 branches × 2 years × 9 lines.

| | |
|---|---|
| `GET /api/yoy` | the stored summary — `{fys, branches:{all,kol,ahm}, updatedAt}` |
| `POST /api/yoy/scan[?fy=2019-20]` | rebuild everything, or only those years |
| `GET /api/yoy/tree?branch=&line=` | the accounts under one line, every year at once |
| `GET /api/yoy/vouchers?branch=&ledger=&from=&to=` | the vouchers behind one account |
| `GET /api/yoy/party?branch=&section=&measure=` | the Sales Analysis sections, every year at once |
| `GET /api/yoy/diag?q=&fy=&branch=` | why one party's figure is what it is (read-only) |

The whole payload, month detail included, is one small request — so opening a year
costs nothing. Rebuilds run in the background (Render's proxy will not wait for a
full read) and coalesce: a rebuild asked for while one runs is remembered and run
after, so a back-fill pushing several years never starts several scans. `/ingest` and
`/sync` refresh **only the financial years their payload touched** (endpoints *and*
the years between), so the daily sync costs one year.

Two deliberate differences from the P&L tab, stated under the table:
- **Stock change is not included** — it comes from an uploaded template covering the
  current period only. So Gross Profit here is Revenue + Purchases + Direct Expenses.
- **Per-browser overrides are not applied** — ledger-category and invoice-account
  overrides live in each browser's localStorage, invisible to the server.

### Opening a line down to the accounts

A line expands to the same nested group tree the P&L tab draws, down to the individual
ledger, and a figure on a ledger opens the vouchers behind it. Three decisions make
that work at a decade's scale:

**The tree is not stored — the per-ledger detail is.** `yoy_detail` holds one document
per branch+line: `ledger -> { fy: [12] }`, sparse, so an account that traded in two of
eleven years carries two arrays. A one-year rebuild has to leave the other ten alone,
and years can be spliced in and out of that shape; a nested tree cannot. The tree is
built when a line is opened (`treeFrom`) and cached until the next rebuild.

**The tree itself is the portal's.** `plEngine` lifts `buildTree` out of
`portal/index.html` alongside `classify`, so the grouping, the roll-ups and the
ordering are the P&L tab's, not a second implementation that could drift.

**The months of every year lie end to end.** One array, Apr of the first year at slot
0, Mar of the last at `12n−1` — the layout `buildTree` already takes (it accepts
`monthCount`) and the one the columns need: a year's total is the sum of its twelve
slots, and opening a year reads those same twelve. Sent as `{slot: amount}`; thousands
of parties × 132 zeroes is not worth the wire.

`test_yoy_tree_fake.js` checks the claim that matters: for every branch, every line and
every year, the accounts in the tree sum back to the line's own total — which
`test_yoy_fake.js` has already matched against the browser. A ledger dropped for
landing in no group, a year read at the wrong offset, or consolidated forgetting to
eliminate the branch account all surface as a mismatch there.

### Explaining one party's figure — `/diag`

"This customer is in Year on Year and not in the date-range view, why?" took a
conversation and three screenshots to answer, and still ended in a guess. `/diag/`
answers it in one search, and `/api/yoy/diag` behind it returns three things:

1. **Every ledger whose name contains the search** — with its group chain, whether it
   is a Sundry Debtor or Creditor, and whether the merge map folded it into another
   name. The usual answer lives here: **one customer has two or three ledgers**
   (`… - DR`, `… (AHD)`), and each page shows whichever of them had activity.
2. **What the stored fold holds** for those names, month by month, per section and
   measure — so a stale rebuild is visible instead of assumed.
3. **Every voucher touching any of them, and what the fold did with it**: its revenue
   and purchase legs, the parties on it, and which party took the invoice — or why
   nobody did.

The three answers that account for nearly every "missing" row, all visible in (3):

- the invoice went to a **bigger debtor on the same voucher** (the whole invoice
  follows the largest party, so a customer can be on a voucher and absent from its
  own row);
- the voucher has **no revenue leg** (an adjustment journal), so it counts for nobody
  in the sales sections — on *both* pages;
- the income is **not under Sales Accounts**, so it shows in Net + charges and not in
  Net (P&L).

**The explanation is the fold, not a retelling of it.** `explainVoucher` calls the same
`attribution()` that `addPartyVoucher` calls, so the reasons cannot disagree with the
stored figures — `test_yoy_diag_fake.js` folds the same fixture independently and
checks every party the diagnostic names carries that figure to the rupee.

### The two companies' ledger tables are merged Kolkata-first

Each Tally company has its own ledger list, and the same NAME can exist in both under
a different group — `Carbonlite Print & Publishing` is a Sundry Debtor sitting directly
under the group in one company and inside a salesperson's group in the other.

`mergeHierarchies` (portal) settles it: **h1 wins, h2 only fills the gaps**, called as
`mergeHierarchies(kolkata, ahmedabad)`, with `TPG`'s default group parents applied at
the end. The server built the same table by hand with `Object.assign` in a `kol, ahm`
loop — which is **last** wins — so a shared name classified one way on the P&L tab and
another in the year-on-year fold. The customer then appeared directly under
SALES · SUNDRY DEBTORS in one view and one level down inside a salesperson's group in
the other, which reads as a row that is simply not there.

`mergeHierarchies` is now lifted like the rest, and `mergedHierarchy(db)` is the only
way the server builds that table — the fold, both trees and the diagnostic share it.

### Where an outstanding bill comes from

A party's outstanding on the Projected page is not one source but two, added together
by `combinedFIFO`:

```
outstanding = the uploaded Bills CSV (a Tally snapshot, stored in `inputfiles`)
            + the invoices inside the LOADED DATE RANGE
            - that range's receipts
```

So a bill can be open in Tally and absent here for a reason that is nobody's mistake:
it belongs to a financial year the range does not cover, **and** it is newer than the
CSV snapshot, so neither source carries it. The CSV is uploaded by hand and kept
("upload once, retained"), which is exactly how it goes stale.

`/diag/`'s fourth section shows both sources at once for one party: when each CSV was
uploaded, the newest bill in it, that party's rows in it, and — from the vouchers,
**every year regardless of the loaded range** — each bill reference with what was
raised, what was settled against it and what is still open. Two lists close the
question: references **only in the CSV** (a year the range does not reach) and
references **only on vouchers** (the file is older than the bill).

One caveat it also surfaces: bill-wise allocations have only been captured since
**19 August 2026** (`Collect-BillAllocs`). A voucher pushed before that carries no
allocations, so its receipts fall back to oldest-bill-first instead of settling the
bill Tally settled. Re-pulling that year fixes it.

### Can the uploaded bills file be retired?

The Bills CSV exists because the pipeline once pulled vouchers and masters but not
the bill-wise allocations. It has pulled them since **August 2026**
(`Collect-BillAllocs`), so outstanding could in principle come from the vouchers
alone — no upload, nothing to go stale, no gap to open between a snapshot and a date
range.

Whether it *actually* can is a measurement, not a guess, and dropping the file on a
guess would silently lose whatever it alone still carries. `GET /api/bills/coverage`
(page: `/diag/bills.html`) answers it and changes nothing:

- **how far back the vouchers carry allocations**, per branch, month by month — the
  month the bar starts is the month the allocations begin;
- **every bill the files still show open, against the vouchers**, matched by
  reference: how many are found, how many are not, and what the unfound ones are
  worth — with the first 25 named, so the year to re-pull is obvious.

A reference the vouchers do not carry is **not yet a missing bill**. Tally lets a bill
reference be re-typed after the invoice is raised, and the CSV is an old snapshot: it
can still name the reference as it was while the voucher carries the corrected one.
So an unfound reference is looked for a second way — by the **voucher number** the
reference was copied from — and accepted only when an allocation on that voucher is
the same size, so an unrelated voucher sharing a number is never quietly counted as a
match. Those come back as `renamed`, listed with both names side by side, and they do
not count against the verdict.

`verdict.csvStillNeeded` is the answer. Zero unfound bills and the upload can go;
anything else names the cost of dropping it. Re-pulling the years those bills fall in
turns the answer over, since a re-pull brings their allocations with it.

**The measurement, run September 2026:** every one of the 4,832 bills the three files
show open is carried by the vouchers — 4,830 under the same reference, 2 under one
Tally had since re-typed. Kolkata's allocations reach back to **April 2015**, so the
whole back-fill has them. The upload is no longer the source of anything.

**The CSV is kept regardless.** It stays as a *backup* — a record of what Tally said
on 31 March 2025 — not as a *fallback*: nothing computes outstanding from it once the
vouchers do, and no code path may silently return to it when a figure looks wrong. A
number that disagrees is a bug to find, not a reason to reach for the older source.

### Does outstanding come out right from the vouchers?

Coverage only says every bill is *somewhere* in the vouchers. It does not say the
figure agrees — an allocation netted the wrong way round leaves every bill present and
every number wrong. `GET /api/bills/audit` (page: `/diag/outstanding.html`) asks the
harder question, and changes nothing:

**Both sides are read at the same instant.** The uploaded file is a snapshot Tally
printed on one day, so the vouchers are netted only up to that same day. That day is
not the newest bill's date — that is when an invoice was *raised*, and a report printed
months later still lists it. Tally computes "overdue by N days" against the day it
prints, so **each row carries the print date: due date + overdue days**. Rows not yet
overdue say 0 and are skipped; the day the most rows agree on wins, so one mistyped due
date cannot move the comparison. `snapshotFrom` says which rule was used.

Then, per bill reference, every allocation is added up, on one Dr-positive scale:
**open = −(sum of its allocations)**, so money owed *to* us is positive and money owed
*by* us is negative. References netting to zero are closed and drop out. **Every ledger
carrying an allocation counts**, not only the Sundry Debtors and Creditors — Tally
lists a bill against whatever ledger it was raised on (fixed-asset purchases and
commission accounts turn up in the files), and filtering by group reports the file's
own rows as missing money.

**A branch's two files are one expectation.** Tally splits a party between the
receivable and the payable report by the **sign of its balance**, not by the group it
sits in: a customer in credit is printed under payables. Comparing file against file
therefore puts the same party on both sides of the answer, so the receivable file is
taken as +ve, the payable as −ve, and the two are netted per party per branch.

**A branch whose vouchers do not reach the snapshot date is set aside**, with the
reason, and named in `verdict.branchesNotCompared`. Ahmedabad's vouchers start April
2025, so against a March 2025 snapshot every one of its bills would read as lost —
that is the question being wrong, not an answer to it.

**The comparison is party by party, never a total.** Two errors cancel in a total and
cannot in a list of parties, so `verdict.safeToSwitch` is true only when every party
with an open bill agrees to the rupee. Parties present in one source and not the other
are named and sided (`onlyIn`).

**Two spellings of one customer are separated out first.** By far the commonest
difference is not money: a bill raised against one spelling and settled against
another leaves one ledger over-settled by exactly what the other reads unpaid. Those
are matched by that **exact cancellation and a shared word** — the cancellation alone
would pair unrelated parties that happen to differ by the same amount — and returned
as `pairs`, a merge list for the portal's `🔗 Merge names` editor. They do not count
against the verdict; `differAfterPairs` is what is actually about money.

**What is left is counted by shape**, not left as a list of a thousand rows: parties
the vouchers show open and Tally does not, parties the vouchers show *over*-settled,
parties only Tally knows, and parties both know but disagree on — each with its money.
Within each, `oneSidedParties` counts those whose difference is mostly made of
**references we hold only one side of**: an invoice with no settlement, or settlements
against an invoice raised before the vouchers we hold begin. Where those dominate, the
answer is about how far back the vouchers reach, not about the accounting. Every party
links through to `/diag/?q=` for the bill-by-bill story.

**And a third reading, which needs no bill references at all: the party's own ledger
balance**, every posting to its name added up. Bill-reference netting is only ever as
good as the references Tally was given — a receipt posted *on account*, or a year-end
"Due As on" balancing bill, leaves every invoice reading open forever though the
account is square. The balance cannot drift that way. Where the balance agrees and the
bill netting does not, it is the references that are incomplete, not the money, and
outstanding should be built on the balance with the references kept for the ageing.

**Only ledgers that can *be* outstanding are read** — Sundry Debtors and Creditors,
plus whatever the uploaded file itself names, since Tally raises bills against
fixed-asset and commission ledgers too. Sweeping in the sales, bank and expense
ledgers gives a grand total of exactly **zero**, because a full set of books nets to
zero by double entry; a balance total of 0 across thousands of "parties" is the
signature of that mistake, not of a company that owes nobody anything.

NCTB is the case that settled this: four export invoices totalling ₹3.08 Cr show
`settled: 0` and the bill netting calls ₹2.48 Cr open, while the ledger balance comes
to **exactly zero** — the ₹2.39 Cr receipt of February 2017 was posted without naming a
bill. Tally is right to omit the party; the references are simply not there to net.

Asking for `?asOn=` a later date is how the reason to stop uploading becomes visible —
the vouchers carry invoices raised since the file was printed, and the file cannot.

### One customer, two names

A party renamed in Tally — or simply entered twice under two spellings — is one
customer, and the dashboards merge it before adding anything up: `__cdcCanon` resolves
a ledger by its **GUID**, with the shared alias map (`/api/aliases`, the `🔗 Merge
names` editor) bridging an old name the master no longer holds.

**The year-on-year fold applies the same merge**, using the same lifted function
(`plEngine` takes `__cdcCanon` out of the portal alongside `classify` and `buildTree`).
It did not, once, and the result was a customer whole on the Sales Analysis page and
split across two rows in the year-on-year panel — with the name that lost the merge
showing on one page and missing from the other. That is what
`test_yoy_party_fake.js` now pins: a customer invoiced under the old name in one year
and the current one in the next has to be a single row, matching the browser.

Two consequences worth knowing:

- **Saving the merge map rebuilds every year.** Merging two names changes which party
  each year's figures belong to, so `POST /api/aliases` triggers a full background
  rebuild rather than leaving a decade of stored figures keyed on the old split.
- **The drill-down looks up every spelling.** The fold stores a party under its
  current name, but the vouchers keep whatever was typed at the time, so
  `/api/yoy/vouchers` matches the canonical name **and every variant merged into it**
  (`aliasVariants`). Without that, a merged customer's row was there and clicking it
  came back empty for the years booked under the old name.

### The Sales Analysis tab, year on year

The panel opens on **Sales Analysis**, not the P&L — the office reads a year by
customer before it reads it by income account. It is the Sales Analysis page's own two
sections, over every financial year at once:

- **SALES · SUNDRY DEBTORS** — each sale attributed to the **largest Sundry Debtor on
  the voucher**, nested under that party's Tally groups, so it opens salesperson →
  company → party.
- **PURCHASES · SUNDRY CREDITORS** — the same for purchases, on the creditor side.

and the same three measures, which are three different folds of the same invoices:

| | |
|---|---|
| `netpl` | the **Sales/Purchase Accounts** legs only — ties to the P&L's Sales line |
| `net` | every revenue/purchase leg, so shipping, freight and other incomes count |
| `gross` | the party's own leg — the full invoice, GST included |

**Consolidated is not the sum of the two branches here.** Dropping the inter-branch
ledgers changes *which party is dominant* on a voucher, and the dominant party is who
the whole invoice is attributed to — so `all` is accumulated in its own pass rather
than merged afterwards. The dashboard makes the same distinction: its branch filter
clears `ibLedgers` when one branch is shown alone.

Storage follows `yoy_detail`, one level wider: `yoy_party` holds
`branch|section|measure` as a **run of chunk documents** (`…#0`, `…#1`, 1500 parties
each), because every customer and every supplier × three measures × a decade would run
at Mongo's 16MB ceiling in one document. The chunks are read back as one map, spliced
per year exactly as the line detail is, and the tail of a run that shrank is deleted.

`test_yoy_party_fake.js` pins the claim that matters: the same vouchers through the
browser's `processData` in Chromium and through `yoySummary.js`, comparing **every
party, measure, branch and year** — including the dominant-party switch that
consolidation causes.

Two things the drill-down does NOT do, both on purpose: a **group** row offers no
voucher list (it is many accounts, not one), and a long list is **capped** at 500 with
a note rather than streamed — the point is to see what is in a figure, and a month
answers that better than two thousand rows of a year.

The voucher lookup matches a ledger by **key list**, not by a dotted path: Tally names
contain dots ("A.B. Traders"), which Mongo would read as nesting. Narrowed by branch
and date first, so only one year of one branch is ever examined.

Growth % is read the way each kind of line is read:

- **Cost lines** (purchases, expenses, outflows) are stored negative and compared by
  **size**: `(|cur| − |prev|) / |prev|`. A salary bill a tenth bigger reads +10%.
- **Value lines** (revenue, GP, NP, inflows, net cash) are compared **signed** over
  last year's size: `(cur − prev) / |prev|`. This matters when a line crosses zero —
  a ₹7.15 Cr profit becoming a ₹10.85 Cr loss read as **+52% in green** under a
  magnitude comparison; signed, it reads −252% in red, which is what happened.

Both rules apply at **every depth** — a ledger's column is read exactly like the line
above it, or the same account reads green on one row and red on the next.

The **financial year in progress** is compared against the **same months** of the
year before (Apr–Aug vs Apr–Aug), never five months against a full twelve, and its
column is labelled `part year · to <month>`. Only the newest column can be partial:
an older year whose February happens to be empty is finished, not unfinished.

Cells are tinted from white at no change to green or red, deepening with the size of
the move and capped at 50% so the ranking below that stays visible — green where the
move helps profit, red where it hurts.

## ONE PARTY, TWO NAMES (party merge suggestions)

CDC keeps one Tally company per financial year, so a party renamed between years
arrives as two unrelated ledgers: old vouchers under the old name, new ones under
the new. Tally's ledger GUIDs are per company, so a back-filled year's GUIDs say
nothing against the live one — nothing links the two automatically, and the
dashboard shows one customer twice, each holding half their history.

`server/aliasSuggest.js` ranks candidate pairs on the evidence actually in the data.
It scans **every** voucher, not the range the browser has loaded — the old name
usually lives in a year nobody has open.

That is well over a hundred thousand documents once the back-fill years are in, so
the scan is **not** a request: `POST /api/alias-suggestions/scan` starts it and
returns immediately, the result is written to the `alias_scan` doc, and
`GET /api/alias-suggestions` serves whatever was last computed (the UI polls every
3 s while one is running, showing the running voucher count). Doing it inline
returned **502** — Render's proxy gave up waiting. The cursor is streamed rather than
collected, so cost is linear and memory near-flat: 150,000 vouchers fold in ~0.7 s at
~34 MB; 600,000 over eleven financial years fold in ~2.5 s at ~90 MB, scoring ~8,000
ledgers in another 40 ms. Wall-clock is dominated by fetching the documents from
Atlas, not by the work. A scan counts as dead only after 10 minutes with **no
progress** — timing it from the start would let a second scan begin beside a healthy
slow one. Accepted and dismissed pairs are filtered when the result is read, so
acting on one suggestion never invalidates the scan.

| Evidence | Source | Weight |
|---|---|---|
| Same GSTIN | `vouchers[].details.partyGstin`, `masters.contacts[].gstin` | 0.93 |
| Shared bill reference | a receipt under one name settling the other's bill | 0.93 |
| Same PAN, different GSTIN | GSTIN chars 3–12 (second-state registration) | 0.75 |
| Same phone / email | ledger master contacts | 0.45 each |
| Name similarity | token Jaccard after stripping Pvt/Ltd/M-s | ≤ 0.7 |

Weights combine as noisy-OR, so no single weak signal reaches certainty. Then the
rename test: **if both names are active in the same period the score is cut by
55%** — a rename means the old name stops and the new one starts, so two names
invoicing in the same months are far more likely to be two real sister concerns.

Hard rules that no score can override:
- a debtor is never merged into a creditor;
- two different GSTINs under two different PANs are two different legal entities,
  unless a shared bill reference says otherwise;
- a ledger's GSTIN is the value its own history votes for (≥2 occurrences, ≥60%,
  clear of the runner-up) — one mistyped GSTIN can cost a match but never cause one.

Tiers: ≥0.9 `certain`, ≥0.7 `likely`, ≥0.5 `possible`; below that it is not shown.
**Nothing is applied automatically** — a wrong merge silently moves one party's
money onto another's ledger. Suggestions appear in the portal's 🔗 Merge names
dialog with their evidence; Accept writes the alias, "Not same" is remembered in
the shared alias doc (`aliases.dismissed`) so it is never offered again.

Covered by `npm run test:alias` (rename found, sister concerns refused, GSTIN typo
survived, 3,300 ledgers in ~0.2 s) and `npm run test:browser:alias` (the panel end
to end in Chromium).

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
