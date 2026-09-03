# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tally ERP → MongoDB → browser dashboards for a two-branch printing company (Kolkata
`kol`, Ahmedabad `ahm`). Three layers, each in its own language:

```
Tally HTTP-XML gateway (:9001, or :9019 on a shared RDP box)
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
npm run test:meta              # /api/meta coverage windows
npm run test:reset             # /admin/reset scoping
npm run test:alias             # party name-merge suggestions
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
  -TallyUrl "http://localhost:9019" -IngestUrl "https://…" -IngestToken "REAL_TOKEN" -ChunkSize 1000
```

## Invariants that are easy to break

**`portal/index.html` is the maintained artifact; `build-portal.js` is stale.** The
build script assembles the portal from `consolidated/` + `projected/`, but the portal
has since gained the branch selector, party aliases, Compare, and the year-on-year
panel — none of which exist in its "sources". Running it would silently delete them.
Edit `portal/index.html` directly.

**The server does not re-implement the dashboard's accounting.** `server/plEngine.js`
lifts `classify`, `getChain`, `monthKey`, `buildTree`, `__cdcCanon`, `CASH_VCH`, `PL_CATS` etc. out
of `portal/index.html` **by regex** and runs them in `vm`. Renaming or reshaping one of
those functions in the portal throws a named error at server startup — that is
deliberate, and the fix is to update `WANTED` in `plEngine.js`, never to copy the logic.

**Tally's signs are kept raw.** `-ve` = Dr, `+ve` = Cr, so revenue is positive and
expenses negative, and nothing calls `Math.abs()` on a monthly figure — reversed
entries must net out. Growth % therefore reads cost lines by size and value lines
signed (see the year-on-year section of `CDC_Dashboard_Logic_Reference.md`).

**A voucher's key is `branch:guid`.** Two companies can never collide, so re-pushing
one branch cannot overwrite the other's data. The `ledgers` vs `party_ledgers` split is
by group ancestry (Sundry Debtor/Creditor, Bank, Cash, Bank OD, Branch → `party_ledgers`).

**PowerShell 5.1 files must be pure ASCII**, and so must every placeholder in a
copy-pasteable command (`REAL_TOKEN`, not a token or a non-Latin word) — a non-ASCII
byte in a command the user pastes raises a ByteString error.

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

**A party's name is merged before it is folded.** One customer under two spellings is
one row: the fold runs every voucher's ledger names through the portal's own
`__cdcCanon` (GUID first, then the shared `/api/aliases` map). Skipping that put the
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
