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

**A voucher's narration is at `details.narration`, never at the top level.** The extractor's
voucher object is `{date, party, no, type, ledgers, party_ledgers, details, guid}` -- the
narration, reference, GSTIN and the rest live inside `details`, whitelisted there by
`DETAIL_SCALARS` in `ingest.js`. A Mongo projection of `narration: 1` therefore asks for a
field no voucher has and hands back `undefined` for every row, which renders as an empty
column rather than as an error. Both `/api/capex` and `/api/yoy/vouchers` shipped that way;
the capex test's fixture now writes narration where the real pull writes it, so reading the
wrong field fails by name.

**A group whose NAME says "Fixed Assets" is not necessarily one.** Kolkata files the
suppliers of its machines under `Current Liabilities > Sundry Creditors > Sundry Creditor -
Fixed Assets`. Testing the joined chain for `'fixed assets'` therefore made every one of
those creditors an asset, and ONE printer produced four rows: the real asset leg, the
creditor leg (a CREDIT, so read as a disposal of the same amount), the bank payment that
settled it months later (read as a second purchase, "financed by a loan" because the OD was
the other leg), and the exchange difference on it. What decides it is where the chain ROOTS
-- `assetDepth()` walks it top-down and a payables/receivables/bank group reached BEFORE any
fixed-asset group disqualifies everything beneath it. What is dropped this way is returned
as `excludedGroups` and shown on the page, because a real asset group filed somewhere
unusual must be visible, not discovered a year later.

**Money moving between two asset accounts is neither a purchase nor a sale.** When the
Ahmedabad factory was finished, one journal credited every work-in-progress ledger it had
been accumulated in and debited the finished asset. Read leg by leg that was a 44 Cr
"disposal" of machines nobody sold, and the SAME 44 Cr counted again as assets bought --
the building and every machine in it appearing twice, once as the WIP leaving and once as
the asset arriving. So a voucher's asset legs are weighed against each other first:
`min(assetDr, assetCr)` is a TRANSFER, only the excess on either side is a real purchase or
disposal, and the transfer is reported in its own section (`moved`, `movedOut`) rather than
in either figure. A capitalisation journal nets to exactly nothing, which is the right
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

**A MACHINE SUPPLIER THAT HAS NEVER SOLD US A MACHINE is named, not dropped.** The group
and name rules take an account's word for it and then count every rupee through it, so a
monthly consumable filed in a machinery creditors group rides along for years -- stitching
wire at 5-15 L a month came to over a crore of "capex" with not one asset to show for it.
`neverSold` lists every party recognised by group or name (not by `via:'sold'`, where the
question is moot) that received money in the window and appears nowhere in `seenSupplier`.
It is still COUNTED: the group Tally files an account in is a better authority than anything
guessed here, so the doubt is reported and the user decides.

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
money may have left earlier, later, or over five years. So each row carries `funded`
(cash / credit / loan / other), read off that voucher's OTHER legs, with a loan leg
winning over a creditor leg because a machine on term finance usually touches both. The
header shows additions and paid-from-bank separately for that reason. Disposals are
reported apart and NEVER netted into spend. `npm run test:capex`.

**CAPEX FOR THE PERIOD asks nothing of anybody's judgement, and is the headline.**
`capexFlow` = assets capitalised + rise in capital advances - rise in what is owed to
machinery creditors. Three balances Tally itself keeps, and NO opinion about which supplier
sells machines -- the opinion that has now been wrong in both directions (a freight
forwarder counted in full, a machine maker left out). It follows the CHANGE in those
balances, never the payments, and that is what stops an advance and the machine it buys
being counted twice: pay 3 Cr of advance (advances +3 Cr, capex 3 Cr); the 5 Cr machine
arrives with 2 Cr owed (capitalised +5, advances -3, owed +2 => 0, because the 3 went out
last year and the 2 has not gone); pay the 2 (owed -2 => 2). Three periods, 3 + 0 + 2 = the
5 Cr machine, each rupee in the period it left. `npm run test:capex` drives exactly that
machine through three windows. Signs: an advance is a Dr-positive ASSET (`-all[k]`), a
creditor a Cr-positive LIABILITY (`+all[k]`). A machine on a term loan IS in this figure
though no money left the bank -- the bank paid the supplier and the company owes the bank.

**Cash out on capex is a different question, followed on the PAYMENT voucher.** An asset is
capitalised the day it is ready and paid for on its own vouchers, often months earlier, so
the asset ledger is the wrong place to look for money. `cashRows` is built from every
voucher that CREDITS a bank, cash or OD ledger, taking the part of it DEBITED to an asset,
to a machinery creditor, or to a capital advance -- the debits rather than the bank total,
so a payment run settling one machine and three paper bills contributes only the machine.
An **advance against a machine that has not arrived** is capex cash the day it is paid; that
is most of what the user wanted and it never touches a fixed-asset ledger. Selling an asset
is NOT negative cash out (that netted a disposal into spend, which the page refuses
everywhere else), but a refund from a machinery creditor or advance IS. `capexPartyKind`
recognises those accounts from the GROUP (Kolkata's is `Sundry Creditor - Fixed Assets`,
Ahmedabad's advances sit under `Advance for Machinery`) and the ledger name for advances
only -- a creditor is matched on its group alone, because the ledger name there is a
company's name and matching it would make "Machine Oil Suppliers" a capex account. Never
match bare `capital`: `Capital Account` is the ROOT of every chain in Tally and would make
the whole company capex. `machinary` is in `CAPITAL_KW` because that is how the Ahmedabad
masters spell it.

**But vocabulary runs out, so the suppliers are LEARNED from the purchases.** Requiring the
words `plant & machinery` missed `Advance for Machinery` entirely, and with it nearly all of
the capex cash -- the cash figure read 83 L against 13 Cr of assets bought and looked merely
small rather than broken. A first pass now reads the purchases themselves and takes every
payable CREDITED on a voucher that DEBITS a fixed asset as a supplier of that asset
(`seenSupplier`, kind `supplier`): evidence rather than vocabulary, so a machinery supplier
filed in the ordinary creditors group is still counted. The page says which way each account
was recognised, and `advanceGroups` lists every group with "advance" in it WITH a counted
flag, so an advance account the rule still misses is visible instead of silently absent.

**A COMPANY THAT SELLS MACHINES PUTS IT IN ITS NAME.** Matching creditors on their GROUP
alone was too strict in the other direction: `Pinghu Bindex Machinery Co.,Ltd.` is a
binding-machine maker filed under ordinary Sundry Creditors, still being paid in
instalments, so no group said machinery, no purchase voucher existed to learn from, and it
was absent from the page entirely. A creditor is therefore matched on its NAME too, with
the consumables and services that ride in on the same words refused by hand
(`NOT_CAPITAL_NAME`: spare, parts, oil, lubric, repair, service, hire, rental, freight,
clearing, insurance...). This is the one rule here that guesses from English, so
`capexPartyKind` returns `{kind, via}` and the page says per account whether it was
recognised by its GROUP (a fact about the books), its NAME (an inference) or by having SOLD
us an asset -- and a name match is listed as that one company rather than counted into
"Sundry Creditors". `capexNameNearMiss` names what the refusal list threw out, because a
wrong word in that list would take a real machine supplier off the page in silence.

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

**The supplier pass looks ONE YEAR BEHIND the window, and may fail without taking the page
with it.** It only ever read the window on
screen, so a machine bought in March and paid in April taught it nothing -- the purchase is
what identifies the supplier and names the bill. A second narrow query (`lookFrom`,
projecting only ledgers/bills) covers that. It carries `maxTimeMS` and a try/catch: this
pass only improves the narrowest rule and the headline figure does not use it at all, so a
slow lookback costs a little accuracy in one column and SAYS so (`lookbackNote`), where an
unbounded one returned a gateway error and took the whole page down.

**A PARTY IS NOT A CATEGORY, so an evidence-recognised supplier counts only on the BILL the
asset was bought on.** `Emirates Logistics` is a freight forwarder; its clearing charges on
one import were capitalised into a machine, which is correct accounting -- and made it a
"machinery supplier", after which its every routine invoice counted as capex cash: ten
ordinary payments, 1.76 Cr, none of it capital. A bill reference is exact where a party is
not. Pass 1 therefore also records the refs raised on asset vouchers (`capexBill`, keyed
`br|ledger|ref`), and in pass 2 a `supplier` leg contributes only what this payment
ALLOCATES against one of those refs -- a payment naming no such bill contributes nothing.
This applies ONLY to `supplier`: a group kept for machinery (`capital_creditor`, `advance`)
says every rupee through it is capital, so those still count in full. What is dropped is
totalled as `unmatchedSupplier` and stated on the page, because money deliberately left out
of a figure has to be visible. Requires `bills` in the voucher projection.

**AN ADVANCE STOPS BEING ONE WHEN THE MACHINE TURNS UP.** The label was written the day
the money left and never revisited, so payments for presses long since installed still read
"machine not here yet". Every posting to an advance ledger is collected (`advPost`) and run
FIFO in date order: a credit releases the OLDEST money sitting in the account, which is how
an advance account actually behaves -- the first proforma paid is the first machine to
arrive. A payment whose own money has been released becomes kind `advance_done`; part-
released counts as still open, because the machine is not here until all of it is. The two
total apart on the cards, so "still out against machines not here" is readable rather than
worked out by hand. `capexFlow` is untouched by this -- it never counted payments.

**WHAT a payment is and HOW we knew are two columns, not one.** The cash list had
"paid a machinery supplier" and "paid a supplier who sold us an asset" as if they were two
kinds of payment; they are the SAME kind -- settling a machine supplier's bill -- recognised
two different ways, and a reader could only wonder which bucket was which. `kind` is now the
stage of the purchase (`asset` paid straight for one, `advance` before delivery, `creditor`
settling a bill) and `via` is the evidence (`group` / `name` / `sold`), each its own column
and its own filter. The bill restriction keys off `via === 'sold'`, not off a kind, because
that is what it was always really about: an account that EXISTS for machinery counts in
full, an account inferred from one purchase counts only on that purchase's bill.

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

`/diag/ledger.html` settles an argument about ONE ledger: export it out of Tally and the
page names the vouchers that differ, by number. Reach for it the moment a party's balance
is disputed — a total disagreeing says nothing about where, and hunting a decade of
vouchers by hand is not a plan. Its parser is lifted out of the page by regex and tested
(`npm run test:export`); renaming `readExport` fails that suite by name, deliberately.

When a figure is questioned, reach for `/diag/?` before theorising: it names the
ledgers behind one party, what the fold stored, and what it did with every voucher.
Its reasons come from the fold's own `attribution()`, so they cannot drift from the
numbers — keep it that way.
