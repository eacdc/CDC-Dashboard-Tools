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

## Notes for this testing copy

- **Branches:** `run_daily.ps1` loads both:
  - `kol` -> company `CDC PRINTERS 2025-26`
  - `ahm` -> company `CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26`
- **Company name must match Tally exactly** (including any year suffix) or the
  gateway returns empty with no error (see `Tally_Extraction_Documentation.md` §5.3).
- **Idempotent:** re-running any date is safe — vouchers upsert on GUID.
