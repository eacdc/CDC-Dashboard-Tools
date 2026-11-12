# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tally ERP → MongoDB → browser dashboards for a two-branch printing company (Kolkata
`kol`, Ahmedabad `ahm`). Three layers, each in its own language:

```
Tally HTTP-XML gateway (127.0.0.1:9001, or :9019 on a shared RDP box)
   └─ pipeline/TallyToJson.ps1      PowerShell 5.1 extractor
        └─ POST /ingest or /sync    server/  (Express + MongoDB Atlas)
             └─ GET /api/*          portal/, consolidated/, projected/, dashboard/, voucher/
```

`server/` serves both the API and the static pages, so the whole thing is one Render
service (`render.yaml`, `rootDir: server`). Live at `https://cdc-finance-automated.onrender.com`.

## Commands

All from `server/`:

```bash
npm start                      # http://localhost:3000 (needs MONGODB_URI in .env)

npm run test:sync              # incremental sync + the delete guards
npm run test:yoy               # year-on-year fold, its API, the drill-down trees,
                               # and the Sales Analysis sections
npm run test:proj              # what a party still owes: the receivables engine,
                               # lifted out of the portal (projEngine.js) and run in Node
npm run test:loans             # loan movement arithmetic, and /api/loans end to end
npm run test:capex             # fixed-asset additions: what, when, and how funded
npm run test:funds             # funds flow: the arithmetic, then /api/funds end to end
npm run test:tb                # trial balance: the rules, then ingest -> /api/tb end to end
npm run test:meta              # /api/meta coverage windows
                               # (test:yoy also covers /diag, the party explainer)
npm run test:reset             # /admin/reset scoping
npm run test:alias             # party name-merge suggestions
npm run test:export            # reading Tally's own ledger export (/diag/ledger.html)
npm run test:backfill          # historical (--historical) pushes

node test_sync_guards_fake.js  # any single suite runs standalone
```

Suites ending `_fake.js` stub the Mongo driver and need no database or network — run
them freely. The browser suites drive real Chromium via `playwright-core`:

```bash
npm run test:browser:yoy       # year-on-year panel, expand → vouchers
npm run test:browser:alias
npm run test:browser           # needs sample JSON as argv: node test_browser.js MASTER.json TXNS.json
MONGODB_URI="..." npm run test:db   # real cluster; creates and drops a throwaway db
```

Chromium lives at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (never run
`playwright install`). Tests locate it by probing that path and `/opt/pw-browsers/chromium`.

A pipeline pull (run on the Windows box, not here):

```powershell
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
  -FromDate 20250401 -ToDate 20260901 -Branch kol -Company "…(Kolkata) - 2025-26" `
  -TallyUrl "http://127.0.0.1:9019" -IngestUrl "https://…" -IngestToken "REAL_TOKEN" -ChunkSize 1000
```

## Invariants that are easy to break

**`portal/index.html` is the maintained artifact; `build-portal.js` is stale.** The
build script assembles the portal from `consolidated/` + `projected/`, but the portal
has since gained the branch selector, party aliases, Compare, and the year-on-year
panel — none of which exist in its "sources". Running it would silently delete them.
Edit `portal/index.html` directly.

**The server does not re-implement the dashboard's accounting.** `server/plEngine.js`
lifts `classify`, `getChain`, `monthKey`, `buildTree`, `mergeHierarchies`, `__cdcCanon`,
`CASH_VCH`, `PL_CATS` etc. out
of `portal/index.html` **by regex** and runs them in `vm`. Renaming or reshaping one of
those functions in the portal throws a named error at server startup — that is
deliberate, and the fix is to update `WANTED` in `plEngine.js`, never to copy the logic.

**Tally's signs are kept raw.** `-ve` = Dr, `+ve` = Cr, so revenue is positive and
expenses negative, and nothing calls `Math.abs()` on a monthly figure — reversed
entries must net out. Growth % therefore reads cost lines by size and value lines
signed (see the year-on-year section of `CDC_Dashboard_Logic_Reference.md`).

**What a party owes is decided by the SIGN of its own posting — never by the other leg
of the voucher, and never through `Math.abs()`.** Cr a Sundry Debtor settles a bill, Dr
raises one (creditors mirrored), on every voucher type except the non-posting ones listed
in `NOPOST`. The voucher type decides exactly one thing: a sale or purchase opens its bill
as a `New Ref`, so that is all that is read when one of those *raises* a bill. Two
separate wrong figures came from breaking this, both reported as "the portal disagrees
with Tally": the PCFC journal below, and a **return** booked on a `Sales ...` /
`Purchase ...` type, which `Math.abs()` turned into a fresh invoice — wrong by *twice* the
returned value, and the reason a paper supplier read 6.29 Cr against Tally's 1.62. Seven
per-type collection branches are deliberately collapsed into one; do not re-split them.
The engine used to try to
recognise a settlement by its contra leg — a journal counted only when a *loan* ledger
was debited, or the other branch appeared — and an export invoice knocked off against a
PCFC loan defeated that in four ways at once (the loan sits under Bank OD, so the
extractor files it under `party_ledgers`; its group chain carries no loan keyword
because `getChain` omits the ledger's own name; the type is "Journal - Export", not
`'Journal'`; and the contra leg may be exchange difference or a bad debt). Every one of
those left an invoice open for ever at full value. `/api/bills/audit` always netted
allocations without a voucher-type filter, so the server and the portal disagreed, and
the server was right. Do not reintroduce an inference from the contra leg;
`npm run test:proj` holds each shape, and `server/projEngine.js` lifts the engine out of
`portal/index.html` by regex so a rename fails that suite by name.

**A voucher's key is `branch:guid`.** Two companies can never collide, so re-pushing
one branch cannot overwrite the other's data. The `ledgers` vs `party_ledgers` split is
by group ancestry (Sundry Debtor/Creditor, Bank, Cash, Bank OD, Branch → `party_ledgers`).

**PowerShell 5.1 files must be pure ASCII**, and so must every placeholder in a
copy-pasteable command (`REAL_TOKEN`, not a token or a non-Latin word) — a non-ASCII
byte in a command the user pastes raises a ByteString error.

**Tally is reached on `127.0.0.1`, never `localhost`.** On Windows `localhost` resolves
to the IPv6 loopback `::1` first, and Tally's HTTP server answers over IPv4 far more
reliably — an IPv6 request can leave its socket in `CLOSE_WAIT`, which wedges the
listener until Tally is restarted and reads as "Unable to connect to the remote server"
from then on, however open the company is. `netstat -ano | findstr :<port>` shows both
the address family and the stuck socket.

**Every scheduled task on the Tally box must run as a logged-on user.** Tally is a
desktop application with no service mode, so a task set to *run whether the user is
logged on or not* gets no desktop and finds no Tally at all — it then fires on time and
logs "no company answered", which looks like a Tally problem and is not. That is why
`Install-CdcAutostart.ps1` registers both tasks `-LogonType Interactive` and triggers
them **at logon**, and why `StartTally.ps1` (the watchdog that starts Tally when the
gateway is silent) can close the reboot gap but cannot remove the need for Windows
auto-login. `StartTally.ps1` also never kills a running Tally unless asked
(`-RestartWedged`): an unsaved voucher on screen is not an unattended task's to discard.

**`-Branch` must match the `-Company` being pulled.** The script guards on the city in
the company name; overriding it with `-AllowBranchMismatch` is how a branch's data ends
up under the other's.

## How data gets deleted (and why old years are safe)

Three paths, and only three:

1. `/sync` replaces a **changed date**: the day is deleted, then the payload re-inserted.
   Guarded — if a date is reported changed but the payload carries no vouchers for it,
   the stored day is left alone and a warning is returned (a failed pull must not empty a day).
2. `/sync` **reconciles**: vouchers in the scan window that Tally no longer lists are
   removed. Guarded — if Tally's list matches under half of ≥50 stored vouchers in the
   window, the reconcile refuses rather than wiping a window it clearly cannot see.
3. `POST /admin/reset` — explicit, and the only path that reaches outside
   `scanFrom..scanTo` (which starts at `-SyncFromDate`, default `20250401`).

So back-filled years (2015-16 onward, all Kolkata) cannot be touched by the daily sync.
`test_sync_guards_fake.js` covers each path, including a day genuinely emptied in Tally
and refilled days later.

## Year-on-year: what is stored vs what is computed

The landing page shows every financial year before anything is loaded, because a decade
of vouchers cannot travel to a browser. Three collections back it:

- `yoy_summary` — one small doc: six lines × 12 months × FY × branch (`all`/`kol`/`ahm`),
  where `all` drops inter-branch ledgers. Sent whole, so opening a year costs no request.
- `yoy_detail` — one doc per `branch|line`, holding `ledger -> { fy: [12] }`, sparse.
  Trees are **not** stored: a one-year rebuild must leave the other ten alone, and years
  splice in and out of that shape where a nested tree cannot. `GET /api/yoy/tree` builds
  the tree on demand (portal's own `buildTree`) and caches it until the next rebuild.
- `yoy_party` — the Sales Analysis sections (sale → its largest Sundry Debtor, purchase
  → its largest Sundry Creditor), keyed `branch|section|measure` and split into chunk
  docs `…#0`, `…#1` of 1500 parties: every customer × three measures × a decade does
  not fit one document. Consolidated is accumulated in its own pass, not merged from
  the branches — dropping the inter-branch ledgers changes which party is dominant,
  and the dominant party takes the whole invoice.

**The two companies' ledger tables merge Kolkata-first.** `mergeHierarchies(kol, ahm)`
is first-wins; a `kol, ahm` `Object.assign` loop is last-wins, and a ledger name living
in both companies under different groups then classifies differently here and in the
browser. `mergedHierarchy(db)` in `server.js` is the only way to build it.

**A party's name is merged before it is folded.** One customer under two spellings is
one row: the fold runs every voucher's ledger names through the portal's own
`__cdcCanon` — GUID first, then the shared `/api/aliases` map, then, for a name the
master no longer holds, the master ledger whose name matches once **punctuation and case
are ignored** (`norm()`, the same equivalence `findParent` uses to classify). That last
step is what makes a Tally rename merge by itself: matching names exactly made
`A.K.Trading Paper Pvt.Ltd.` and `A K Trading Paper pvt ltd` two parties, and the old
one's money did not split off but *vanished* — a name in no master is Unclassified, so it
is neither a debtor nor a creditor and its invoices leave receivables/payables
altogether, while the P&L, which normalises, kept counting it. Only a normalised form
belonging to exactly ONE master ledger is used (two real ledgers differing by punctuation
must stay two), and an alias already saved always wins. Skipping any of this put the
customer whole on the P&L tab and split in two in the year-on-year panel. Saving the
merge map rebuilds every year, and `/api/yoy/vouchers` looks up every spelling merged
into a name, because the vouchers keep whatever was typed at the time.

Rebuilds run in the background (Render's proxy will not wait) and coalesce. `/ingest`
and `/sync` refresh only the FYs their payload touched — endpoints *and* the years
between. The months of all years lie end to end in one array: year *i* owns slots
*i*·12 … *i*·12+11.

## Testing philosophy

Two kinds, and the split matters:

- `*_fake.js` — stub the Mongo driver in `require.cache` and assert behaviour. Fast,
  hermetic, and where the guards and splicing logic are pinned.
- Browser suites — load the real page in Chromium and compare the server's figures
  against the dashboard's own `processData`. The year-on-year fold exists only because
  it agrees with the P&L tab to the paisa; `test_yoy_fake.js` proves that in a real
  browser, and `test_yoy_tree_fake.js` then proves the drill-down trees sum back to
  those already-verified lines.

Assertion messages are written as claims about the business ("a day genuinely emptied
in Tally IS cleared, by the reconcile"), not as labels. Keep that style.

## Front-end shape

Every page is a single HTML file with one big inline React script (React 18 UMD,
`e = React.createElement`, no JSX, no build step). Libraries are vendored in `vendor/`
and served from the same origin — a CDN the office network cannot reach used to leave a
blank white page. The pages fall back to cdnjs only when opened straight off disk, and
say on the page if neither works.

Because the script is inline and single-quoted throughout, an apostrophe in a string
(`an account's figure`) is a syntax error that renders nothing. After editing
`portal/index.html`, check it:

```bash
python3 -c "import re;s=open('portal/index.html',encoding='utf-8').read();open('/tmp/p.js','w').write(re.findall(r'<script>([\s\S]*?)</script>',s)[-1])" && node --check /tmp/p.js
```

## Reference docs

- `CDC_Dashboard_Logic_Reference.md` — the accounting rules, per tool: classification,
  cashflow direction, inter-branch elimination, year-on-year, party merging, delete paths.
  Update it when the logic changes; it is the file that explains *why* a number is what it is.
- `pipeline/SETUP.md` — Windows/RDP setup, shared-port collisions, wrong-company recovery,
  `/api/meta` coverage checks.
- `pipeline/README.md`, `server/README.md` — per-layer detail.
- `CDC_CHANGELOG.md` — user-visible changes, newest first.

`/diag/bills.html` answers the standing question of whether the manual Bills CSV
upload can be retired now that the pipeline pulls bill-wise allocations
(`/api/bills/coverage`): it counts the bills the file shows open that no voucher
carries. As of September 2026 that count is **zero** — Kolkata's allocations reach
back to April 2015 — so the upload is no longer the source of anything. A reference
the vouchers lack is checked a second way first, by the voucher number it was copied
from at the same amount: Tally re-types bill references, and a re-typed one is not a
missing bill.

**The CSV stays as a backup, never a fallback.** It is a record of what Tally said on
31 March 2025; nothing computes a figure from it once the vouchers do, and no code
path may return to it when a number looks wrong. A disagreeing number is a bug.

**And it may never be added on top of vouchers that already hold the same bills.** The
projection used to seed its openings from the uploaded CSV *and* take the invoices out of
the vouchers, so once the loaded window reached back past a bill's own date that bill was
counted twice — exactly 2×, and whether or not the reference still matched, since Tally
re-types references and two spellings became two bills. One supplier read 6.29 Cr against
roughly half that in Tally, and name-merging cannot touch it. `buildProjection` now drops
an opening whose date the voucher window covers, keeps the ones it does not reach, and
**reports what it dropped** (`openingsDropped`). Note the bills slots are cached in the
browser between sessions, so a file uploaded months ago is still being applied — and
uploading a *fresh* CSV to check a figure used to double every party on it.

`/diag/clients.html` writes the client list to a workbook: every Sundry Debtor as ONE row
(spellings merged), its contacts taken from whichever spelling actually carries them, and
its sales per financial year from the same `yoy_party` fold the Sales Analysis tab reads —
never a second scan, or the sheet and the dashboard could disagree about one customer.
First/last sale dates come from `branch|sales|seen`, written per FY in the fold's own
pass; PAN/address/state/country come from a separate `LedgerDetail` request in
`TallyToJson.ps1`, kept separate so an unrecognised field name cannot take the daily
voucher sync down.

`/diag/loans.html` is the borrowing statement: opening, drawn, repaid and closing for every
loan account, by day, week or month, with each period's closing carried into the next so it
can be read straight down and checked against Tally at any date in it. It is
**Cr-positive** -- a loan outstanding is a POSITIVE number, the opposite of the Dr-positive
scale the receivables code uses, because "outstanding: -1,62,00,000" is a figure that gets
misread. The arithmetic is in `server/loanMovement.js` with no database in it, so
`npm run test:loans` drives it directly; `/api/loans` is a thin adapter over it.

Which ledgers count is decided by the GROUP Tally put them in (Secured Loans, Unsecured
Loans, Bank OD/OCC, Loans (Liability)), plus a ledger under Current Liabilities whose
**name** says packing credit, PCFC, cash credit, bill discounting, WCDL, term loan or
buyer's credit -- the group chain never contains the ledger's own name, which is how every
PCFC account hid from the cashflow tab for a year.

**Export credit is a kind of its own, split out of Secured Loans.** The group picks the
family (`od_cc` / `unsecured` / secured / other) and then `EXPORT_KW` (pcfc, pcre, packing
credit, bill discount, pre/post-shipment, export credit/finance) splits secured and other
into `export` vs `term`, read from the sub-group AND the ledger name. Tally files PCFC and
PCRE under Secured Loans because they are secured, but a packing credit drawn per shipment
is not a seven-year loan on a press and one total answers neither question. `Buyer's
credit` is NOT export credit -- it finances imports. An `od_cc` account keeps its kind
whatever facility it funds, since a sweeping account is reported by its balance.
`KIND_ORDER` fixes the display order short-term first; do not sort by size. `Loans & Advances (Asset)` is money WE
lent and is never counted; a ledger named like a loan but grouped elsewhere ("Term Loan
Interest") is listed as a **near miss** rather than silently dropped. Note that
`'unsecured loans'` CONTAINS `'secured loans'`, so the group keywords are ordered and must
not be sorted -- a test fails by name if they are.

**An opening balance must be asked for BY DATE.** `OPENINGBALANCE` with no
`SVFROMDATE`/`SVTODATE` is the opening of whatever period the company is sitting in --
1 Apr 2026 for a company opened in 2026-27 -- while `openingAsOn` came from `BOOKSFROM`,
1 Apr 2025. Storing the first and labelling it the second made every balance computed as
*opening + postings since openingAsOn* count a whole year twice. Proved to the paisa
against Tally's own group summary: six loan accounts low by exactly their FY 2025-26
repayments, a dormant director loan exactly right (no postings, nothing to double), and
two PCFC accounts Tally shows at nil reading as crores *in debit*. The error is
proportional to how much the account moved, which is why unsecured matched while OD was
60 Cr out. The request now names the period and fetches `CLOSINGBALANCE` too, so
`masters.closing`/`closingAsOn` let any page check itself against Tally per account. This
affects every `masters.opening` reader -- the loan page, `/diag`'s party balance,
`/api/bills/audit` -- and needs ONE pipeline run to take effect.

**A loan is keyed `branch|ledger`, classified from that branch's OWN master.** The merged
hierarchy is Kolkata-first, so a name that is a Bank OD in Kolkata and a bank account in
Ahmedabad read as a loan for both -- and `/api/loans` then took Ahmedabad's opening and
postings for that name as loan figures. Tally has `Citi Bank, (Kolkata)` at 6.36 Cr in
Kolkata and `Citi Bank, (Ahmedabad)` at 1.41 L in Ahmedabad, two accounts; Ahmedabad
*also* carries a `Citi Bank, (Kolkata)` outside its loan group holding 39.35 Cr, and that
phantom is what made one row read 79.66 Cr. One query per company, asking only for the
names that are loans in it, and the alias map scoped per branch so a party merge cannot
weld two companies' bank accounts together.

The opening is Tally's own opening balance (`masters.opening`, stored Tally-raw so a
liability is +ve) plus every posting between the day it stands on and the window start --
and MINUS any posting inside the window but before that day, which the opening already
contains. It is returned in **two halves** (`openingParts.tally` / `.postings`) because
when an opening disagrees with Tally, which half is wrong IS the diagnosis: a wrong Tally
half means the master, a wrong postings half means vouchers we do not hold. On a sweeping
OD the postings half is a year of turnover, so a small gap there moves the opening by
crores. A branch whose openings were never pulled gets movement, and the page says so
rather than presenting it as a balance.

**An OD or CC account sweeps, so its gross flow is not borrowing** -- every receipt pays
it down, every payment draws it up. One Citi OD showed 204 Cr drawn against 169 Cr repaid
in seven months, which was 223 Cr of a 277 Cr headline and buried the 54 Cr of real new
facilities. So `od_cc` is a `SWEEP_KIND`: the headline reports `drawnFacility` /
`repaidFacility` / `sweepNet`, the page shows net for those accounts, and the gross stays
one checkbox away. The split reconciles to the same closing as the gross
(`opening + drawnFacility - repaidFacility + sweepNet`), and a test holds that per period.
Accrued interest is NOT a borrowing however its ledger reads -- `liability for expenses`
and `provisions` are never-borrowing groups, and the name path also refuses `interest`,
`subvention`, `receivable`, `provision`, `charges`, `commission`, `penalty`. Those block
only the NAME path, so a facility the GROUP says is a loan is untouched.

`/diag/capex.html` (`GET /api/capex`) is what was spent on fixed assets: every posting
that DEBITS a Fixed Asset or capital-work-in-progress ledger, dated, with the item, the
voucher, the supplier and the narration, plus rollups by month / asset / group / funding.
Assets are classified per branch from that branch's own master, as loans are. Depreciation
and repairs are expenses, not capex, and an accumulated-depreciation ledger filed UNDER
the asset group is excluded by name -- writing an asset down is not buying one.

**A voucher's narration is at `details.narration`, never at the top level**, and
`voucher/index.html` must PRINT it. It did on the journal layout and not on the invoice
layout, so sales and purchase vouchers -- nearly every voucher anyone prints -- went out as a
sheet of figures with nothing saying why. One `narrBlock()` now serves both, with
`white-space:pre-wrap` because Tally's narration runs to several lines. `test:voucher` holds
the narration through the sanitiser and `/api/voucher`, newlines and all, and asserts it is
NOT at the top level. The extractor's
voucher object is `{date, party, no, type, ledgers, party_ledgers, details, guid}` -- the
narration, reference, GSTIN and the rest live inside `details`, whitelisted there by
`DETAIL_SCALARS` in `ingest.js`. A Mongo projection of `narration: 1` therefore asks for a
field no voucher has and hands back `undefined` for every row, which renders as an empty
column rather than as an error. Both `/api/capex` and `/api/yoy/vouchers` shipped that way;
the capex test's fixture now writes narration where the real pull writes it, so reading the
wrong field fails by name.

**A `*_fake.js` stub that does not understand a query operator silently matches NOTHING, and
`[].every(...)` is true.** `test_voucher_details.js` did not handle `$ne`, which
`/api/dataset` uses to drop cancelled and optional vouchers, so the suite asserted against an
empty list -- and its three guards (details stripped from the payload, ledger amounts kept,
`guid` kept for the drill-down link) were green having never seen a voucher. When a stub's
matcher is extended, check what was passing on nothing; an assertion over a collection should
be paired with one on its length.

**A group whose NAME says "Fixed Assets" is not necessarily one.** Kolkata files the
suppliers of its machines under `Current Liabilities > Sundry Creditors > Sundry Creditor -
Fixed Assets`. Testing the joined chain for `'fixed assets'` therefore made every one of
those creditors an asset, and ONE printer produced four rows: the real asset leg, the
creditor leg (a CREDIT, so read as a disposal of the same amount), the bank payment that
settled it months later (read as a second purchase, "financed by a loan" because the OD was
the other leg), and the exchange difference on it. What decides it is where the chain ROOTS
-- `assetDepth()` walks it top-down and a payables/receivables/bank group reached BEFORE any
fixed-asset group disqualifies everything beneath it. What is dropped this way is returned
as `excludedGroups`, because a real asset group filed somewhere unusual must be visible, not
discovered a year later. It is no longer a SECTION -- one row saying the same thing about
`Sundry Creditor - Fixed Assets` every time -- but it is a sheet in the workbook, and rule 5
on the page says so. The same goes for the advance accounts the rule did not pick up
(`advanceGroups`, the guard that found `Advance for Machinery` missing): 146 staff advances
and the advance income tax drowned the one row that mattered. Keep both FINDABLE; do not
quietly stop returning them.

**Money moving between two asset accounts is neither a purchase nor a sale.** When the
Ahmedabad factory was finished, one journal credited every work-in-progress ledger it had
been accumulated in and debited the finished asset. Read leg by leg that was a 44 Cr
"disposal" of machines nobody sold, and the SAME 44 Cr counted again as assets bought --
the building and every machine in it appearing twice, once as the WIP leaving and once as
the asset arriving. So a voucher's asset legs are weighed against each other first:
`min(assetDr, assetCr)` is a TRANSFER, only the excess on either side is a real purchase or
disposal, and the transfer (`moved`, `movedOut`) is in neither figure. Those rows are no
longer LISTED on the page -- "moved between asset accounts" is bookkeeping, not a business
figure, and a reader asked what it meant -- but the arithmetic and the API field stay, and
rule 3 on the page still states it. Do not remove the netting with the section. A capitalisation journal nets to exactly nothing, which is the right
answer -- the company owns what it already owned, under a different name.

**THE OTHER COMPANY IS NOT A SUPPLIER.** A ledger whose chain holds `Branch / Divisions`
is the inter-branch account -- the same test `yoySummary` uses to drop it. Kolkata took a
platen die cutter off Ahmedabad and four machines went the other way, and every one was
counted as bought, on top of the original purchase from its real maker, so the same press
appeared twice in a consolidated total. A row whose voucher has an inter-branch
counterparty is flagged `interBranch`, kept out of additions, disposals AND every rollup
(the `roll()` helper skips them, or the page would disagree with its own total), and listed
in its own section. `sliceFor` skips them too, which is what keeps the browser's check
against the server honest.

**A warning nobody can act on trains the reader to skip the ones they can.** Two on the loan
page were doing that. Thirty interest, insurance and subvention ledgers ("Interest on Term
Loan with HDFC Bank") were listed as near misses under *"if this is a real loan, move it
under a loan group in Tally"* -- advice that is wrong every time, since interest owed is not
money borrowed; `nearMiss` now applies `NOT_BORROWING_NAME` and they are reported as a count
instead. And the opening-predates-the-vouchers gap was still shouted under a green
"checked against Tally" verdict: when every compared account reconciles to Tally's own
closing, that gap demonstrably changed nothing, so the note now says so rather than asking
a question the page has already answered.

**An addition is not cash out.** It is recorded the day the asset is capitalised; the
money may have left earlier, later, or over five years. Each row still carries `funded`
(cash / credit / loan / other) on the API, read off that voucher's OTHER legs, but NOTHING ON
THE PAGE READS IT any more. It described which ledger the entry was made against and was
twice taken for a statement about how the machine was paid for -- which it never was, whatever
the label said ("booked to supplier account" was the third attempt at wording it). Do not put
it back on the page without a reading of it that is true. Disposals are
reported apart and NEVER netted into spend. `npm run test:capex`.

**THE PAGE ASKS NO QUESTION IT CANNOT ANSWER FROM TALLY'S OWN ACCOUNTS.** It once chased
capex CASH payment by payment, which meant deciding which creditors sell machines, and that
judgement was wrong in both directions for weeks: a freight forwarder counted in full, a
machine maker left out, a stitching-wire supplier counted for over a crore, and finally two
3.7 Cr Manugraph payments dropped while the 10 L ones stayed. A list that is confidently
incomplete is worse than no list, so it was deleted -- with `capexPartyKind`'s creditor
branch, `seenSupplier`, `capexBill`, the bill matching, `NOT_CAPITAL_NAME`, `neverSold`, the
FIFO advance-settlement labelling and the lookback query. Do not bring any of it back
without a way to prove completeness.

What is left needs no opinion. `capexFlow` = **assets capitalised + the rise in capital
advances**: two accounts, and the CHANGE in them rather than the payments, which is what
stops an advance and the machine it buys being counted twice -- pay 3 Cr of advance
(advances +3 Cr, capex 3 Cr); the 5 Cr machine arrives (capitalised +5, advances -3, so only
the 2 Cr not already advanced is new); paying the supplier later adds nothing. 3 + 2 + 0 =
the 5 Cr machine, and `npm run test:capex` drives exactly that through three windows. It is
**capex committed, not cash**: a machine booked but unpaid is in it, and so is one on a term
loan the bank paid directly. An advance is a Dr-positive ASSET, so its movement is
`-all[k]`. The only party rule still standing is `capexAdvanceKind`, which recognises the
advance accounts themselves.

**A CONSOLIDATED QUERY NAMES NO BRANCH, so `{branch:1, date:1}` cannot serve it** -- `date`
is its second key, so a date-only filter scans the whole decade. Every page asking for both
companies was doing that quietly; `/api/capex` began timing out once it ALSO looked years
behind its window, and a timed-out request comes back as Render's HTML gateway page, which
in the browser reads `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. A plain
`{date: 1}` index exists for exactly this. Any new query that filters on date without a
branch must assume it is scanning unless that index covers it.

**A fetch that expects JSON must read the body as TEXT first.** `r.json()` on a gateway
error page throws a parser message that names neither the request nor the cause, so
`fetchJson` in both diag pages parses the text itself and, on failure, reports the status,
what actually came back, and what usually causes it. A page that cannot explain its own
failure costs a round of "what does this mean?" every time.

**TALLY'S BALANCE SHEET ALREADY ANSWERS TWO OF THESE QUESTIONS, so read its figure rather
than rebuilding one.** "What have we paid for machines that have not come" is the closing
balance of the capital-advance accounts under Current Assets, and it is in `masters.closing`
(Tally-raw, so an asset's Dr is -ve: outstanding is `-closing[ledger]`). Rebuilding it from
the payments in a window can only ever see the window, while the balance carries everything
still out -- an advance paid three years ago for a machine still not here is in Tally's
figure and in no reconstruction of mine. `advanceOutstanding` carries `asOn`, because a
balance means nothing without the day it stands on. **It is NOT `capexFlow.advanceNet`, and
the page must never let the two be read as one figure.** `advanceNet` is the MOVEMENT in the
window (what belongs in a period's capex); `advanceOutstanding.total` is the BALANCE however
long ago it was paid, so it is normally the larger and is usually the one a reader recognises
from Tally. Reading them as the same figure is what made 1.01 Cr look like a wrong answer to
a question 7.70 Cr had already answered; adding them would count every advance again in every
window after the one it was paid in, and counts how many advance accounts had
no closing stored so a half-pulled master cannot read as a small figure. Depreciation for
the period sits beside it for the same reason -- it is an expense and NEVER capex, but
additions, advances out and depreciation are the three lines a reader of the balance sheet
expects together. The depreciation ledgers are matched by name and the contra-asset under
Fixed Assets is excluded, so the charge is counted once.

**The page states its own rules** in a HOW THIS PAGE DECIDES section. There are now five and
they are not guessable from the numbers -- the question "what is the logic behind capex
classification?" is the sign that they belonged on the page rather than only in here.

**`byFunding` describes how the entry was BOOKED, not when money moved.** "Booked to supplier
account" is simply the ledger the purchase was entered against -- it does NOT mean the
machine was taken on credit, and the payment has usually gone out earlier against a proforma.
The old labels ("on supplier credit", "financed by a loan") read as statements about funding
and were disbelieved on sight, correctly. The section is named for what it is and points at
the cash section for the money.

**Every long table filters and sorts, and the TOTAL follows the filter.** A list of 600
capex entries or 133 loan accounts is never read top to bottom -- the question is always
"what did we spend on X" or "what are the big ones". The same engine serves `diag/capex.html`
and `diag/loans.html` (`tHtml` / `tRefresh` / `tRows`, byte-identical in both files; change
one, change the other): a search box, per-table dropdowns built from the data itself
(`distinct`), sortable headings, a "showing N of M" count and a `clear`. Two things it must
keep doing. A filtered total is recomputed from the rows ON SCREEN and labelled "Total of
these N" -- a total still showing the unfiltered figure is read as the answer to the question
just asked. And only the table body and the count are rebuilt as the user types (`tRefresh`),
because replacing the toolbar on every keystroke throws the cursor out of the search box
after one character. Handlers are delegated on `out` and bound ONCE, outside `render`:
per-render binding stacks a handler per load and dies the moment a sort rebuilds the rows
under it -- which is why the loan page's expand toggle moved out of `render` too. `render`
clears the filter state, since a new window is a new question.

**A range box takes what a person would type.** `parseAmt` accepts `1.5cr`, `25L`, `50k`
and plain rupees, because nobody counts the zeroes in 15000000 to ask for "over 1.5 crore"
and a miscounted one silently filters out the thing they were looking for; an unparseable
box turns red rather than filtering on nothing. An amount range sets `skipZero`, because
"bought for under 20 L" means an amount under 20 L, not the absence of one -- without it,
asking for small purchases returned every disposal row too, nought being under everything.
A DATE range does not skip zero and is filtered on `Number(r.date)`.

**On the capex page BRANCH is a filter, not a query.** Both companies come down in one
fetch (`branch=all`) and `sliceFor()` narrows what is shown, so switching is instant
instead of a round trip. That is only legitimate because the server's branch filter is
nothing more than `match.branch = br` over the same vouchers and every figure on the page
is a SUM over the rows. The licence for summing in the browser is that it is CHECKED: for
`all`, `sliceFor` recomputes the totals and compares them with the server's own, and a
disagreement renders a red CHECK FAILED section instead of quietly showing a second
opinion. The workbook exports what is on screen (`shown`), not the whole fetch. The loan
page is NOT sliced this way -- its openings, `drawnFacility` and `sweepNet` come out of
`loanMovement.js` and are not row sums, so its top selector still reloads; its account
table's own branch dropdown needs no reload.

**Charts are inline SVG, light-only, and capped at their natural width.** No chart
library: a CDN this office cannot reach is how a page ends up blank. Categorical hues are
the dataviz reference palette's first five in its FIXED order (colour follows the
category, never its size), validated against the page surface; the legend and the table
view relieve the three slots under 3:1 contrast. Gridlines pick a nice STEP (1/2/5 x
10^k) and let the top follow -- picking a nice top and quartering it labelled a line
"1.3 Cr" that sat at 1.25 Cr. Render the page in Chromium and LOOK at it before shipping:
both of those defects were invisible to every validator and obvious on screen.

**Loan movement and Capex are reached from the portal's own top bar**, beside Consolidated
and Projected, and from the landing page before any upload. The portal embeds
`/diag/loans.html` and `/diag/capex.html` in place rather than re-implementing them: a second
copy of the loan arithmetic in `portal/index.html` is the drift `plEngine.js` /
`projEngine.js` exist to prevent. Both pages fetch `/api/...` at an absolute path, which is
what lets them work equally standalone and embedded.

`/diag/funds.html` (`GET /api/funds`) is the funds flow: where the money went over a period
and how much of it was borrowed. Three balances read off Tally's own accounts -- what
customers owe us, what we owe suppliers, what we owe banks -- plus what was capitalised. The
CHANGE in each says where funds were absorbed and where they came from.

**It calls `computeLoans` and `computeCapex`, and must keep doing so.** Those were lifted out
of `/api/loans` and `/api/capex` for this page: a second derivation of "what was capitalised"
or "what is outstanding" is a second answer waiting to disagree with the page that owns the
question, and the capex rules alone took four wrong answers to get right. The routes are now
thin wrappers over those functions. `npm run test:funds` asserts the capex half IS the capex
page's figure.

**A receivable arrives from Tally NEGATIVE** -- it is a Dr -- and the sign is turned exactly
once, at the edge, in `fundsFlow.js`. Receivables are reported Dr-positive and payables and
loans Cr-positive, for the reason the loan page gives: "payables: -4,10,00,000" is a figure
that gets misread. One missing turn here puts what customers owe us on the wrong side of the
statement and inverts the whole thing.

**WHICH COLUMN A LINE FALLS IN IS DECIDED BY ITS SIGN, never by what the line is.** Trade that
releases money funds the business as surely as a loan does, and a year of repaying debt
absorbs funds as surely as a machine. A statement that files each line on a fixed side
reports a year of deleveraging as though nothing happened -- `side()` in `fundsFlow.js`, and a
test drives the mirror-image year.

**STOCK IS NOT IN IT, deliberately**, because the inventory in Tally is not maintained closely
enough to put a figure on, and a working-capital statement carrying a number nobody trusts is
worse than one that says it has none. Cash, taxes and the rest of the balance sheet are out
too. **So `residual` is a BALANCING FIGURE and is never to be labelled profit** -- it is what
the tracked uses cost beyond the tracked borrowing and nothing more. It appears on the page as
*met from within the business*, with the caveat beside it, so the two columns visibly add up;
calling it profit would be a claim neither the file nor the page can support.

**The opening stands at the close of the day BEFORE the window starts** (`dayBefore`), and each
balance is built the way the loan page builds one: Tally's own opening on the day it stands,
plus every posting since -- MINUS any posting after the date asked for but before that day,
which the opening already contains. Both directions matter. Where the window happens to end on
the day `masters.closing` stands, the page compares the two and says whether it reconciles.

**THE ADVANCE *MOVEMENT* USES NO OPENING BALANCE AT ALL, and the advance *balance* exists for
exactly one date.** `capexFlow.advanceNet` is the sum of the postings on the capital-advance
ledgers inside the window (`fl.advanceNet -= all[k]`, per voucher) -- nothing is read from
`masters.opening`. So it is complete only where the vouchers are, and it is understated by
whatever happened before the oldest one held. `advanceOutstanding` IS a balance, and it comes
from `masters.closing`, which stands on ONE day: `closingAsOn`, the end of the period of the
last LIVE pull. There is no stored advance balance for any other date, and a back-fill of an
old year deliberately does not write `opening`/`closing` (ingest.js) because one doc per
branch would have it overwrite the current ones. **A balance "as on 1 April 2024" therefore
does not exist in this database** -- the figure for such a window is movement, not a balance.
Storing balances per branch PER FINANCIAL YEAR (each FY is its own Tally company,
`... (Kolkata) - 2025-26`, and the extractor already asks for `OPENINGBALANCE`/`CLOSINGBALANCE`
by date) is the fix, and it would retire this limitation for debtors, creditors and loans too.

**A BALANCE WALKED BACK NEEDS THE STRETCH IT WALKS, and the gap is COUNTED, not assumed.**
`/api/funds` carries Tally's opening to the start of the window posting by posting, so the
span between `openingAsOn` and the window start must be covered by vouchers held. Where the
oldest voucher is newer than that, the opening is wrong by whatever came first -- silently,
because every row still adds up. Both pages now measure the uncovered stretch in DAYS and
shout only past 31 of them: 1 April is a holiday and the books open a few days in, so a
window opening on the 1st against a first voucher on the 10th is missing nothing, and
shouting about it would train the reader to skip the warning that matters. Kolkata is
back-filled to 2015-16 and Ahmedabad is not, so a window can be right for one company and a
year short for the other -- which is exactly the case the note exists for.

**Consolidated drops the inter-branch accounts** filed under Sundry Debtors or Creditors -- the
same `Branch / Divisions` test everything else here uses. One company's receivable from the
other is the other's payable and the group is owed nothing, so `kol` and `ahm` deliberately do
not add to `all`, and the page says so.

`/diag/tb.html` (`GET /api/tb`, `/api/tb/coverage`) is the trial balance as on any date,
one company at a time, and the proof that the capture is whole. `server/trialBalance.js`
holds the arithmetic with no database in it; `npm run test:tb` drives it and then the real
ingest end to end.

**BALANCES ARE STORED PER PERIOD, in `balances`, keyed `branch|from`.** `masters` is one
document per branch and can hold one opening and one closing, which is why only the live
company ever had any and why a back-fill was forbidden to write its own. A revenue ledger
starts each financial year at nil, so an old year's opening cannot be rebuilt from vouchers
either. Each snapshot holds that period's `opening`, `closing`, its OWN chart of accounts
(`ledgers`/`groups` whole -- not `histLedgers`' "names the live master lacks", since a
ledger alive today may have sat under another group then) and its `vtypes`. They ride
INSIDE the master payload (`master.snapshots`), so `/ingest`, `/sync`, a targeted push and
`loader.js` all carry them with no second transport; `storeSnapshots` runs in BOTH master
modes. `masters.opening`/`closing` are untouched and every existing reader still uses them.

**An empty snapshot is the shape of a failed pull and is never stored** -- it would read as
every ledger at nil and make every statement for that year confidently wrong. The extractor
does not send one and `cleanSnapshots` drops one. Same reasoning as `/sync` refusing to
empty a day on a pull that brought nothing.

**WHICH VOUCHERS POST is decided by the reserved type at the ROOT of the voucher type's
parent chain** (`vtypes`, a separate `VoucherType` request), never by the name: "Purchase -
Fixed Assets" is a Purchase, a type created from Sales Order is an order. `NON_ACCOUNTING_BASE`
in `trialBalance.js` is matched exactly against that root. It is NOT the portal's `NOPOST`:
that list is about what moves a party's bills and includes Payroll, which posts to the books.
A type the master does not hold is judged by name prefix and REPORTED (`typesJudgedBy`,
the `guessed` note) -- a guess must not look like a fact.

**NO PERIOD, NO ANSWER.** `pickSnapshot` returns the latest period starting on or before
the date, only while the date is inside that period's financial year; otherwise `/api/tb`
answers `noPeriod` and lists what is held. Never fall back to a neighbouring year's opening.

**THE CHECK IS MADE AT `snapshot.to`, WHATEVER DATE WAS ASKED FOR**, in the same aggregation
(two cut-offs, `lo`/`hi`, grouped by a period flag). Opening + every posting to that day
against Tally's closing, per ledger, including ledgers Tally closes with a balance that no
voucher of ours touches. `openingDifference` (Tally's own openings not balancing) and
`closingDifference - openingDifference` (a voucher of ours not balancing) are reported
apart, because the first is in the books and the second is a capture fault.

**A ledger the chart holds under NO group sits under `Primary`** (`Profit & Loss A/c`); only
a ledger the chart does not hold at all counts as `unclassified`.

**No consolidated trial balance.** The branches are separate Tally companies, so there is no
Tally figure to check a combined one against, and an unchecked statement is not what this
page is for.

**Extractor (cannot be run here -- no PowerShell in this sandbox; keep edits surgical and
ASCII).** Per-FY snapshots are dated requests like the legacy opening one: ONE attempt,
60s (300s under `-Historical`/`-BalancesOnly`), never fatal. `-Incremental` asks only for
the year `-ToDate` falls in; a full or historical pull asks for every year from `-FromDate`
(or `BOOKSFROM`) to `-ToDate`; a window identical to the legacy request reuses its answer.
`-BalancesOnly` pushes masters + snapshots + voucher types with NO vouchers and NO
`from`/`to` (so no year-on-year rebuild is triggered) -- it is how an already back-filled
year gets its balances in minutes; `run_backfill.ps1 -BalancesOnly` loops the years under
its own state key (`#balances`). A day the Day Book will not answer for is collected in
`$script:FailedDays`, retried once, sent as `master.failedDays`, and fails the run with
exit 5 -- it used to return an empty list and be indistinguishable from a day with no
entries, so a year could be ticked off with a hole in it. Exit 6 = balances-only got none.

**Still not collected** (deliberately out of scope, listed so nobody assumes otherwise):
gross Dr/Cr where one voucher hits a ledger on both sides (netted in the extractor), cost
centres, stock items / godowns / stock valuation, bank reconciliation dates and instrument
details, foreign-currency amounts and rates, the bill-wise breakup of opening balances
(the Bills CSV backup covers 31 March 2025), and who entered or altered a voucher.

`/diag/ledger.html` settles an argument about ONE ledger: export it out of Tally and the
page names the vouchers that differ, by number. Reach for it the moment a party's balance
is disputed — a total disagreeing says nothing about where, and hunting a decade of
vouchers by hand is not a plan. Its parser is lifted out of the page by regex and tested
(`npm run test:export`); renaming `readExport` fails that suite by name, deliberately.

When a figure is questioned, reach for `/diag/?` before theorising: it names the
ledgers behind one party, what the fold stored, and what it did with every voucher.
Its reasons come from the fold's own `attribution()`, so they cannot drift from the
numbers — keep it that way.
