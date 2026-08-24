# Setup — Tally → MongoDB → Dashboards (testing copy)

Three moving parts:

1. **Extractor** (`pipeline/`, PowerShell) — runs on/near the Tally server, pulls data, pushes to Mongo.
2. **API** (`server/`, Node) — reads Mongo, serves `/api/dataset` + the dashboards.
3. **Dashboards** (`consolidated/`, `projected/`) — fetch from the API in "MongoDB (auto)" mode.

> **Security:** the Atlas URI/password is a secret. Set it as an environment
> variable only — never commit it. If you pasted it into a chat, rotate it in
> Atlas (Database Access → edit the DB user → new password) and update the env var.
> Also add your machine(s) to Atlas **Network Access** (the local Tally box and
> wherever the API runs). For a quick test you can allow `0.0.0.0/0`, then tighten.

---

## A. One-time: stand up the API

Anywhere that can reach Atlas (your PC for testing, or Render for a shared URL):

```bash
cd server
cp .env.example .env
#  edit .env:
#    MONGODB_URI=mongodb+srv://USER:PASS@YOUR-CLUSTER.mongodb.net/Tally_Live?retryWrites=true&w=majority
#    INGEST_TOKEN=some-long-random-string      (only needed for the hosted-API push path)
npm install
npm start          # -> http://localhost:3000   (dashboards at /consolidated/ and /projected/)
```

Sanity check: open http://localhost:3000/api/meta — should return `{}` counts until you load data.

For a shared deploy, use `render.yaml` (set `MONGODB_URI` + `INGEST_TOKEN` as Render secrets).

## B. One-time: historical backfill (1 Apr → today)

On the Tally server (Tally running, company loaded, gateway on 9001). Pick ONE push path:

**Path 1 — direct to Atlas (needs Node + `MONGODB_URI` on this machine):**
```powershell
setx MONGODB_URI "mongodb+srv://USER:PASS@YOUR-CLUSTER.mongodb.net/Tally_Live?retryWrites=true&w=majority"
# (reopen the shell so setx takes effect)
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -FromDate 20250401 -ToDate 20260716 -Branch kol -Company "CDC PRINTERS 2025-26"
node ..\server\loader.js --dir "$env:USERPROFILE\Desktop\tally_export" --branch kol
```

**Path 2 — through the hosted API (PowerShell only, no Node needed):**
```powershell
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -FromDate 20250401 -ToDate 20260716 `
  -Branch kol -Company "CDC PRINTERS 2025-26" `
  -IngestUrl "https://YOUR-API-URL" -IngestToken "some-long-random-string"
```

A full year is ~250 day requests (~a few minutes; run off-hours — 11 users share that server).

**On `413 Payload Too Large`:** a whole year is tens of thousands of vouchers and
one JSON body of that size is refused outright — nothing is stored. Both push paths
now send in chunks of 2000 vouchers, so this shouldn't happen; if it still does,
lower the batch: `-ChunkSize 500` on the `.ps1`, or `--chunk 500` on `loader.js`.
The files stay on disk either way, and every push is an idempotent upsert on
`branch:guid` — so just re-running is safe and costs nothing but time:

```powershell
node ..\server\loader.js --dir "$env:USERPROFILE\Desktop\tally_export" --branch kol `
  --url "https://YOUR-API-URL" --token "your-token" --chunk 1000
```

## B2. Multi-year backfill (older financial years, e.g. 2015-16 onwards)

CDC keeps **one Tally company per financial year**, so history is pulled year by
year. `run_backfill.ps1` walks that loop; it is resumable, and it will not disturb
the live sync.

**Step 0 — ask Tally which years it actually holds** (only *open* companies answer):

```powershell
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -ListCompanies
```

**Step 1 — dry run**, to check the FY → company-name mapping before pulling anything:

```powershell
powershell -ExecutionPolicy Bypass -File .\run_backfill.ps1 -Branch kol -FromFY 2015 -ToFY 2024 -Plan
```

Names default to `CDC PRINTERS {FY}` (→ `CDC PRINTERS 2015-16`). Override the odd
year out with `-Companies "2019-20=CDC PRINTERS PVT LTD 2019-20"`.

**Step 2 — run it.** One Tally request per day of history, so a decade is **hours,
not minutes**. Run it off-hours, and expect to do it in sittings — finished years
are recorded in `tally_export\backfill_state.json` and skipped on the next run.

```powershell
$env:CDC_INGEST_URL   = "https://YOUR-API-URL"
$env:CDC_INGEST_TOKEN = "some-long-random-string"
powershell -ExecutionPolicy Bypass -File .\run_backfill.ps1 -Branch kol -FromFY 2015 -ToFY 2024
```

Tally only answers for the companies **currently open** in it. If a year's company
isn't loaded, that year aborts on the `-MinLedgers` safety floor and is *not* marked
done — open it (Alt+F3 → Select Company) and re-run. Run once per branch, on the box
that holds that branch's companies.

### What makes a backfill safe

- **The live ledger master is never overwritten.** A `-Historical` pull sends
  `masterMode: 'merge'`, so the old company's ledgers land in separate
  `histLedgers`/`histGroups` fields. Reads union them with the live master, **live
  winning** — so old-only parties still classify as debtor/creditor, while parties
  opened since 2015 keep their current group. An ordinary sync the next morning
  leaves the backfilled names alone.
- **The incremental sync is untouched.** `-Historical` refuses to combine with
  `-Incremental` (an old company's ALTERID counter would poison the branch's
  high-water mark) and never writes `sync_state`.
- **Nothing is deleted.** Backfill vouchers upsert on their Tally GUID, which is
  per company — so old years can't collide with current ones, and re-running a year
  is a no-op. The incremental sync's deletion reconcile is scoped to the dates it
  actually scanned, so it will never delete backfilled history.
- **Offline Tally box?** Drop `-IngestUrl`; each year is written to
  `tally_export\<branch>_<from>_to_<to>_*.json`. Push each year with
  `node ..\server\loader.js --dir <dir> --branch kol --historical` — the
  `--historical` flag is what keeps the merge semantics (rename the pair to
  `<branch>_Master.json` / `<branch>_Transactions.json` per year first).

### Re-syncing the current year for bill-wise allocations

Bill-wise receipt matching needs the `bills` field, which only vouchers pulled with
the current extractor carry. Vouchers synced before it fall back to date FIFO — no
wrong numbers, just no bill-level settlement. To upgrade the current year, do a
plain full pull (**not** `-Historical`: the current company *is* the live master):

```powershell
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -FromDate 20250401 -ToDate 20260331 `
  -Branch kol -Company "CDC PRINTERS 2025-26" `
  -IngestUrl "https://YOUR-API-URL" -IngestToken "some-long-random-string"
```

It upserts on GUID, so existing vouchers are updated in place — the `bills` field is
added and nothing is duplicated.

### On a shared / RDP machine: make sure you are talking to YOUR Tally

Tally's HTTP port is per-machine, not per-user: whichever instance starts first
binds `9001`, and on a terminal-server box with many people logged in that can be
**someone else's Tally, in another RDP session**. The extractor then pulls whatever
companies *that* instance has open — which looks exactly like "my company is not
loaded", even though it is open on your own screen.

Check who owns the port:

```
netstat -ano | findstr :9001
tasklist /FI "PID eq <the PID it printed>" /V
```

Compare the `Session#` with your own Tally's (`tasklist /FI "IMAGENAME eq tally.exe" /V`
— yours is the row with your username and a window title). If they differ, give your
Tally its own port: **F1 → Settings → Connectivity → Client/Server configuration**,
`Tally acting as: Server` (or Both), `Port: 9019` (any free port — confirm with
`netstat -ano | findstr :9019` that nothing answers). Then pass it to every script:

```powershell
-TallyUrl "http://localhost:9019"
```

`run_daily.ps1` and `run_backfill.ps1` take `-TallyUrl` too — a scheduled task left on
the default `9001` will quietly sync another instance's company into your branch.

### Fixing a branch that got the wrong company

If a pull ran with `-Branch kol` but `-Company "…(Ahmedabad)…"` (or the reverse),
that company's vouchers are now sitting in the wrong branch, and the branch's ledger
master was replaced by the wrong company's too. **Re-running the correct pull does not
fix it**: the two companies' vouchers have different Tally GUIDs, so the keys never
collide, nothing is overwritten, and the branch ends up holding *both* companies —
every total is the sum of two companies.

The wrong rows have to be deleted. `-Reset` does that first, then pushes, and only
after the Tally pull has succeeded (so a Tally that answers badly can never leave the
branch empty):

```powershell
# 1. Kolkata: wipe kol over this range, then push the real Kolkata data
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -Reset `
  -FromDate 20250401 -ToDate 20260820 -Branch kol -Company "CDC PRINTERS 2025-26" `
  -IngestUrl "https://YOUR-API-URL" -IngestToken "some-long-random-string" -ChunkSize 1000

# 2. Ahmedabad: same, with the Ahmedabad company
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -Reset `
  -FromDate 20250401 -ToDate 20260820 -Branch ahm -Company "CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26" `
  -IngestUrl "https://YOUR-API-URL" -IngestToken "some-long-random-string" -ChunkSize 1000
```

Then confirm at `https://YOUR-API-URL/api/meta` — each branch should show a voucher
count and date range that match what Tally reports for that company alone.

- `-Reset` clears **only `-FromDate`..`-ToDate`** for that branch, so back-filled
  older years survive. `-ResetAll` clears every date instead — use it when you don't
  know how far the bad data spread.
- It also drops that branch's master (the next push rebuilds it) and its incremental
  sync high-water mark (an ALTERID from the wrong company means nothing; the next
  incremental sync re-scans). If you have back-filled older years, re-run those
  back-fills afterwards so their `histLedgers` come back.
- Pushing from another machine instead: `node server/loader.js --dir <folder>
  --branch kol --url https://YOUR-API-URL --token <your-token> --reset` (or
  `--reset-all`).
- The endpoint behind it is `POST /admin/reset {branch, from, to}` (or `{branch,
  all:true}`), token-protected like `/ingest`.

### Viewing backfilled years

Fetch **one financial year at a time** (portal date boxes: `01-04-2015` →
`31-03-2016`). Two reasons:

- The dashboard derives "current FY" from the **latest voucher date in the loaded
  range**, and its FY toggle only reaches that year and the one before it. Load
  2015-16 alone and 2015-16 becomes the year on screen.
- `/api/dataset` returns every voucher in the range in one response. A decade at
  once is a very large payload for the browser to parse.

## C. Daily schedule

`run_daily.ps1` auto-detects the push path (API if `CDC_INGEST_URL` is set, else
direct loader if Node + `MONGODB_URI`, else writes files only). Set the env vars
once, then point Task Scheduler at `run_daily.bat`:

- **Direct-to-Atlas:** set machine env `MONGODB_URI`.
- **Via hosted API:** set machine env `CDC_INGEST_URL` (and `CDC_INGEST_TOKEN`).

Task Scheduler → Create Basic Task → Daily (e.g. 2:00 AM) → Action: *Start a program*
→ `...\pipeline\run_daily.bat`. Optional arg `-TrailingDays 7` re-pulls the last
week so edits to recent vouchers are caught. Logs land in `pipeline\logs\`.

## D. View it

Open the dashboard (`/consolidated/` or `/projected/`), keep the default
**MongoDB (auto)** tab, leave API base blank if the page is served by the API
(else paste the API URL), and click **Fetch**. Default range = 1 Apr current FY → today.

---

## Incremental sync (ALTERID) — catches backdated entries, edits & deletions

Tally stamps every voucher with an `ALTERID` that increments on **any** create or
edit, regardless of the voucher's date. The incremental mode uses this to sync
only what actually changed since last run — including **backdated** entries/edits
anywhere in the FY — and reconciles **deletions**.

How a run works:
1. `GET /api/sync-state?branch=X` → the last `ALTERID` we processed.
2. One lightweight metadata scan of the whole FY (`guid + date + alterId` per voucher).
3. Dates containing any voucher with `alterId >` last → **re-pulled in full** and replaced.
4. Any voucher whose `guid` is no longer in Tally → **deleted** from Mongo.
5. High-water `ALTERID` saved back.

Requires the API (`-IngestUrl`). Run it daily instead of the full pull:

```powershell
# both branches, incremental
powershell -ExecutionPolicy Bypass -File .\run_daily.ps1 -Incremental
```
Or one branch directly (dry-run first to see the plan without writing):
```powershell
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -Incremental -DryRun `
  -FromDate 20260401 -Branch ahm -Company "CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26" `
  -IngestUrl "https://YOUR-API" -IngestToken "SECRET"
```
The `/sync` response reports `replacedDates`, `deletedByDate`, `deletedMissing`
(reconciled deletions) and the new `lastAlterId`.

> First incremental run (no state yet) treats everything as changed = a full sync;
> subsequent runs are tiny. The metadata scan is one request even on a full FY.
> **Note:** the Tally metadata-collection request is new — validate one live run
> with `-DryRun` before trusting the nightly job (the `ALTERID`/`GUID` fetch field
> names can vary by TallyPrime build).

## Frequent incremental schedule (every 30 min)

For near-live data, run the **incremental** sync on a short interval instead of
once a day. Use `run_sync.bat` (a thin wrapper for `run_daily.ps1 -Incremental`,
both branches).

**Prerequisites** — if any is missing the job runs but nothing lands in Mongo:
- Tally **open** with the company loaded, gateway on `9001`.
- `CDC_INGEST_URL` (+ optional `CDC_INGEST_TOKEN`) set as a **machine/user env var**
  so the scheduled task inherits it. Incremental needs the hosted API's `/sync`
  endpoint — `MONGODB_URI` alone is **not** enough for incremental. (If the run log
  says *"Incremental requires -IngestUrl … falling back to full pull"* and
  *"mode=files … NOT pushed"*, this env var is missing — that is the #1 cause of a
  stale sync.)
- A user is **logged on** (Tally needs the interactive session).

**One branch per machine.** Each Tally box only has its own company loaded, so
sync only that branch from it — set `CDC_BRANCHES` (or pass `-Branches`):

```powershell
setx CDC_BRANCHES kol      # on the Kolkata box   (setx ahm on the Ahmedabad box)
```

Pulling the other branch from the wrong box returns ~empty ("Ledgers : 1 … 0
vouchers") and just wastes a request. `run_daily.ps1` defaults to both branches
for backwards compatibility, so on a single-branch box you **must** scope it.

**Register the task** (run once in an *Administrator* PowerShell; fix the path):

```powershell
schtasks /Create /TN "CDC_Tally_Sync_30min" /SC MINUTE /MO 30 /F `
  /TR "\"C:\path\to\CDC-Dashboard-Tools\pipeline\run_sync.bat\" -Branches kol"
```
(use `-Branches ahm` on the Ahmedabad box; omit it only if one Tally has BOTH
companies loaded.)

Or via the GUI: Task Scheduler → Create Task → **Triggers** → New → *On a schedule*,
**Repeat task every 30 minutes** for a duration of **Indefinitely** → **Actions** →
Start a program → `...\pipeline\run_sync.bat` → **General** → *Run only when user is
logged on*.

**Verify it's actually running:**
- After a run, the `sync_state` collection's `updatedAt` for **both** `kol` and
  `ahm` should jump to "now" and stay within a few minutes of each other — every
  successful incremental run bumps it, even when nothing changed. A stale or
  one-sided `updatedAt` means the task isn't firing (or is failing).
- `GET /api/sync-state?branch=ahm` returns the current `lastAlterId` + `updatedAt`.
- Each run writes a timestamped log to `pipeline\logs\` — open the latest to see
  the per-branch `sync posted: {...}` line (`replacedDates`, `upserted`, ...).
- Task Scheduler → the task → **History** tab shows the fire times and exit codes.

**Test it by hand first** (proves Tally + env vars + API all work):

```powershell
powershell -ExecutionPolicy Bypass -File .\run_daily.ps1 -Incremental
```

Watch the console for `sync posted:` per branch, then re-check `sync_state.updatedAt`.
If the manual run updates Mongo but the scheduled task doesn't, it's a Task
Scheduler config issue (wrong path, env vars not visible to the task, or "run only
when logged on" not set while the box is locked/logged off).

## Notes for this testing copy

- **Branches:** `run_daily.ps1` loads both:
  - `kol` -> company `CDC PRINTERS 2025-26`
  - `ahm` -> company `CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26`
- **Company name must match Tally exactly** (including any year suffix) or the
  gateway returns empty with no error (see `Tally_Extraction_Documentation.md` §5.3).
- **Idempotent:** re-running any date is safe — vouchers upsert on GUID.
