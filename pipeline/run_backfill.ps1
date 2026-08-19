<#
    run_backfill.ps1  -- multi-year historical back-fill (one company per FY)
    ------------------------------------------------------------------------
    CDC keeps one Tally company per financial year, so pulling history means
    walking year by year: open that year's company in Tally, pull 1 Apr -> 31 Mar,
    push it, move on. This wraps that loop.

    Each year is pulled with TallyToJson.ps1 -Historical, which:
      * MERGES that year's ledger master instead of replacing the live one, so the
        current dashboard hierarchy is never rolled back (see server/ingest.js), and
      * never touches the incremental sync high-water mark, so the daily sync keeps
        working exactly as before.

    Vouchers are upserted on their Tally GUID, so re-running a year is harmless -
    which is what makes this resumable: finished years are recorded in
    backfill_state.json and skipped on the next run (-Force re-does them anyway).

    KEEP PURE ASCII (PowerShell 5.1).

    STEP 0 - find out what this Tally actually holds:
        powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -ListCompanies

    STEP 1 - dry run: see the plan without pulling anything:
        powershell -ExecutionPolicy Bypass -File .\run_backfill.ps1 -Branch kol -FromFY 2015 -ToFY 2024 -Plan

    STEP 2 - run it (hours, not minutes - one Tally request per day of history):
        powershell -ExecutionPolicy Bypass -File .\run_backfill.ps1 -Branch kol -FromFY 2015 -ToFY 2024

    Company names default to "CDC PRINTERS {FY}" (e.g. "CDC PRINTERS 2015-16").
    Where a year's company is named differently, override just that year:
        -Companies "2019-20=CDC PRINTERS PVT LTD 2019-20","2020-21=CDC 2020-21"
#>
param(
    [ValidateSet('kol','ahm')]
    [string]$Branch = "kol",                        # ONE branch per run: each Tally box holds its own company
    [int]$FromFY = 2015,                            # FY start year, i.e. 2015 = FY 2015-16
    [int]$ToFY,                                     # last FY to pull (default: the FY before the current one)
    [string]$CompanyPattern = "CDC PRINTERS {FY}",  # {FY} is replaced with e.g. 2015-16
    [string[]]$Companies = @(),                     # per-year overrides: "2015-16=Exact Tally Company Name"
    [string]$TallyUrl    = "http://localhost:9001",
    [string]$IngestUrl   = $env:CDC_INGEST_URL,
    [string]$IngestToken = $env:CDC_INGEST_TOKEN,
    [string]$OutDir,                                # default: .\tally_export (same as run_daily)
    [int]$MinLedgers = 50,                          # safety floor passed through to the extractor
    [switch]$Plan,                                  # print what would be pulled, then stop
    [switch]$Force,                                 # re-pull years already marked done
    [switch]$ContinueOnError                        # keep going if one year fails (default: stop)
)

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$extract = Join-Path $here "TallyToJson.ps1"
if (-not $OutDir) { $OutDir = Join-Path $here "tally_export" }
$logDir  = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $OutDir,$logDir | Out-Null
$log = Join-Path $logDir ("backfill_" + $Branch + "_" + (Get-Date).ToString('yyyyMMdd_HHmmss') + ".log")
function Say($m){ $line = "[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $m; Write-Host $line; Add-Content -Path $log -Value $line }

# Default the last year to the FY before the current one: the CURRENT year is the
# live company and belongs to the ordinary daily sync, not to a historical merge.
$now = Get-Date
$currentFY = if ($now.Month -ge 4) { $now.Year } else { $now.Year - 1 }
if (-not $PSBoundParameters.ContainsKey('ToFY')) { $ToFY = $currentFY - 1 }
if ($ToFY -ge $currentFY) {
    throw ("ToFY {0} is the current financial year. Sync that one with run_daily.ps1 / a normal full pull - a historical merge would file the LIVE ledger master as history. Use -ToFY {1} or lower." -f $ToFY, ($currentFY - 1))
}
if ($FromFY -gt $ToFY) { throw ("FromFY {0} is after ToFY {1}." -f $FromFY, $ToFY) }

# FY label helper: 2015 -> "2015-16".
function FyLabel([int]$y) { return ("{0}-{1}" -f $y, ("{0:d2}" -f (($y + 1) % 100))) }

# Per-year company overrides, keyed by FY label.
$override = @{}
foreach ($entry in $Companies) {
    $i = $entry.IndexOf('=')
    if ($i -lt 1) { throw ("-Companies entry '{0}' must look like '2015-16=Company Name'." -f $entry) }
    $override[$entry.Substring(0, $i).Trim()] = $entry.Substring($i + 1).Trim()
}

# Resume state: which years are already in Mongo. Keyed by branch so the two
# branches can back-fill independently from the same folder.
$statePath = Join-Path $OutDir "backfill_state.json"
$state = @{}
if (Test-Path $statePath) {
    try {
        $raw = Get-Content -Raw -Path $statePath | ConvertFrom-Json
        foreach ($p in $raw.PSObject.Properties) { $state[$p.Name] = $p.Value }
    } catch { Write-Warning ("Could not read {0} ({1}) - starting with an empty state." -f $statePath, $_.Exception.Message) }
}
function StateKey([int]$y) { return ("{0}/{1}" -f $Branch, (FyLabel $y)) }
function SaveState() {
    ($state | ConvertTo-Json -Depth 4) | Set-Content -Path $statePath -Encoding ASCII
}

# ---- build the plan -------------------------------------------------------
$plan = @()
for ($y = $FromFY; $y -le $ToFY; $y++) {
    $lbl = FyLabel $y
    $company = if ($override.ContainsKey($lbl)) { $override[$lbl] } else { $CompanyPattern -replace '\{FY\}', $lbl }
    $done = (-not $Force) -and $state.ContainsKey((StateKey $y))
    $plan += [PSCustomObject]@{
        FY       = $lbl
        From     = ("{0}0401" -f $y)
        To       = ("{0}0331" -f ($y + 1))
        Company  = $company
        Skip     = $done
    }
}

Say ("backfill plan  branch={0}  FY {1}..{2}  mode={3}" -f $Branch, (FyLabel $FromFY), (FyLabel $ToFY), $(if ($IngestUrl) { "api" } else { "files-only" }))
$plan | Format-Table -AutoSize | Out-String | Write-Host
if (-not $IngestUrl) {
    Say "WARN: no -IngestUrl / CDC_INGEST_URL - each year will be written to disk only."
    Say ("      Push each year later with: node server\loader.js --dir {0} --branch {1} --historical" -f $OutDir, $Branch)
}
Say "NOTE: only the company currently OPEN in this Tally can be pulled. Tally serves whichever companies are loaded; if a year's company is not open, that year returns an empty master and is skipped by the -MinLedgers guard."
if ($Plan) { Say "-Plan given: stopping before any pull."; return }

# ---- run it ---------------------------------------------------------------
$okCount = 0; $failCount = 0; $skipCount = 0
foreach ($row in $plan) {
    if ($row.Skip) { Say ("--- FY {0}: already done, skipping (use -Force to redo) ---" -f $row.FY); $skipCount++; continue }
    Say ("--- FY {0}  ({1}..{2})  company '{3}' ---" -f $row.FY, $row.From, $row.To, $row.Company)
    $failed = $false
    # Built as a list so the ingest switches are omitted entirely (rather than passed
    # as empty strings) on the files-only path.
    $argv = @(
        '-ExecutionPolicy','Bypass','-File',$extract,
        '-Historical',
        '-FromDate',$row.From, '-ToDate',$row.To,
        '-Branch',$Branch, '-Company',$row.Company,
        '-TallyUrl',$TallyUrl, '-OutDir',$OutDir, '-MinLedgers',$MinLedgers
    )
    if ($IngestUrl)   { $argv += @('-IngestUrl',$IngestUrl) }
    if ($IngestToken) { $argv += @('-IngestToken',$IngestToken) }
    try {
        & powershell @argv 2>&1 | ForEach-Object { Say $_ }
        # The extractor exits 2 when the company is not loaded in this Tally (its
        # master came back near-empty). That is a skip, not a success - recording it
        # as done would quietly leave a hole in the history.
        if ($LASTEXITCODE -eq 2) {
            throw ("company '{0}' is not loaded in this Tally (master came back below the {1}-ledger safety floor)." -f $row.Company, $MinLedgers)
        }
        if ($LASTEXITCODE -ne 0) { throw ("extractor exited with code {0}." -f $LASTEXITCODE) }
    } catch {
        $failed = $true
        Say ("ERROR FY {0}: {1}" -f $row.FY, $_.Exception.Message)
    }
    if ($failed) {
        $failCount++
        if (-not $ContinueOnError) {
            Say "Stopping (pass -ContinueOnError to push through failures). Fix the year above and re-run - finished years are skipped automatically."
            break
        }
        continue
    }
    # Only mark a year done once it actually reached Mongo. Without -IngestUrl the
    # files are on disk but NOT loaded, so the year stays open until loader.js runs.
    if ($IngestUrl) {
        $state[("{0}/{1}" -f $Branch, $row.FY)] = (Get-Date).ToString('s')
        SaveState
    }
    $okCount++
    Say ("FY {0} done." -f $row.FY)
}

Say ("backfill finished  ok={0}  skipped={1}  failed={2}  log={3}" -f $okCount, $skipCount, $failCount, $log)
if ($failCount -gt 0) { exit 1 }
