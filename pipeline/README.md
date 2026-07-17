# CDC Tally -> MongoDB Pipeline (testing copy)

Automates what used to be a manual 4-file upload into the Consolidated and
Projected dashboards. Instead of exporting JSON by hand and uploading it, a
PowerShell extractor pulls from Tally, converts to the dashboards' native JSON
shape, and loads it into MongoDB. The dashboards then fetch from Mongo by date
range (default: current financial year to date).

```
  Tally (HTTP-XML gateway :9001)
        |
        v
  pipeline/TallyToJson.ps1   -- pulls masters + day book, emits:
        |                        <branch>_Master.json        (hierarchy: {ledgers, groups})
        |                        <branch>_Transactions.json  (vouchers: [{date,party,no,type,ledgers,party_ledgers}])
        |
        |  (a) direct POST  ->  server /ingest  ->  MongoDB Atlas
        |  (b) no internet  ->  copy files off  ->  server/loader.js  ->  MongoDB Atlas
        v
  MongoDB (collections: masters, vouchers)
        ^
        |  GET /api/dataset?from=YYYYMMDD&to=YYYYMMDD&branch=all
        |
  consolidated/  and  projected/  dashboards  ("MongoDB (auto)" mode)
```

## Why this shape

`TallyToJson.ps1` is the JSON sibling of the original `TallyCSV.ps1`. Same
gateway calls, same Tally gotchas handled (see `Tally_Extraction_Documentation.md`),
but it writes the **two JSON files the dashboards already understand** instead of
7 CSVs.

The one non-trivial conversion is splitting each voucher's ledger lines into
`ledgers` vs `party_ledgers`. Rule (verified to reproduce the reference export at
99.977%): a line goes to `party_ledgers` if any group in its ancestry is a
**Sundry Debtor / Sundry Creditor / Bank / Cash / Bank OD / Branch** head;
everything else (P&L heads, taxes, fixed assets) goes to `ledgers`. Amounts keep
Tally's raw sign (-ve = Dr, +ve = Cr), dates stay `yyyyMMdd` -- exactly what the
dashboards expect.

## Running it

Historical backfill (1 Apr -> today), one company at a time:

```powershell
# Ahmedabad
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
  -FromDate 20250401 -ToDate 20260716 -Branch ahm `
  -Company "CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26" `
  -IngestUrl "https://cdc-dashboard-api.onrender.com" -IngestToken "YOUR_TOKEN"

# Kolkata (adjust company name to the exact Tally name)
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
  -FromDate 20250401 -ToDate 20260716 -Branch kol `
  -Company "CDC PRINTERS 2025-26" `
  -IngestUrl "https://cdc-dashboard-api.onrender.com" -IngestToken "YOUR_TOKEN"
```

Daily incremental (schedule in Windows Task Scheduler, off-hours). Re-running a
day is safe -- ingestion upserts on the voucher GUID, so nothing duplicates:

```powershell
$today = (Get-Date).ToString('yyyyMMdd')
powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
  -FromDate $today -ToDate $today -Branch ahm `
  -Company "CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26" `
  -IngestUrl "https://cdc-dashboard-api.onrender.com" -IngestToken "YOUR_TOKEN"
```

### If the Tally server has no outbound internet

Per the extraction doc, the RDP server may not reach the public internet. In that
case leave `-IngestUrl` empty; the script just writes the two JSON files to
`-OutDir`. Copy that folder to any machine that can reach Atlas and push it:

```bash
MONGODB_URI="mongodb+srv://..." node server/loader.js --dir ./tally_export --branch ahm
MONGODB_URI="mongodb+srv://..." node server/loader.js --dir ./tally_export --branch kol
```

## Notes / limits (testing copy)

- **Backfill order doesn't matter** -- vouchers upsert by GUID; masters upsert the
  latest snapshot per branch.
- **Edits to past-dated vouchers** are only picked up if you re-pull that date.
  Simplest safe pattern: re-pull a trailing window (e.g. last 7 days) each night.
- The dashboards still window to a single financial year (the FY of the range's
  latest date) with the existing Prior-FY toggle -- the date picker chooses which
  data to pull, not a custom month count.
