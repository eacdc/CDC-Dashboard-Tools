<#
    run_daily.ps1  -- scheduled daily wrapper (Windows Task Scheduler)
    ----------------------------------------------------------------
    Fetches the last N day(s) of Tally vouchers for each branch and loads them
    into MongoDB. Re-running is safe (ingestion upserts on voucher GUID).

    It picks a push path automatically:
      1. If CDC_INGEST_URL is set        -> TallyToJson.ps1 POSTs to that API.
      2. else if Node + MONGODB_URI set  -> writes JSON, then node loader.js pushes
                                            straight to Atlas.
      3. else                            -> writes JSON files only (warns).

    KEEP PURE ASCII (PowerShell 5.1).

    Configure via environment variables (set once, machine-level):
      MONGODB_URI       Atlas connection string   (for the direct-loader path)
      CDC_INGEST_URL    e.g. https://cdc-api...   (for the hosted-API path)
      CDC_INGEST_TOKEN  shared secret token       (optional, with CDC_INGEST_URL)
      CDC_TALLY_URL     pins ONE Tally to pull from. Left unset, ports 9019 and 9001
                        are both probed and each company is pulled from whichever is
                        actually serving it -- on a shared or terminal-server box the
                        two branches often sit behind different ports, and 9001 can
                        belong to another user's Tally entirely (see SETUP.md).

    RUN:  powershell -ExecutionPolicy Bypass -File .\run_daily.ps1
          powershell -ExecutionPolicy Bypass -File .\run_daily.ps1 -TrailingDays 7
#>
param(
    [int]$TrailingDays = 1,                         # full mode: 1 = today only; 7 = re-pull last week
    [switch]$Incremental,                           # ALTERID sync (recommended): catches backdated + deletions
    [string]$SyncFromDate = "20250401",             # incremental: earliest date to scan for changes
    # Which Tally to pull from. Left alone, BOTH usual ports are probed and each
    # company is pulled from whichever one is actually serving it -- on a shared or
    # RDP box the two branches often sit behind different ports, and 9001 can belong
    # to another user's Tally entirely. Pass -TallyUrl to pin one, or -TallyUrls to
    # change the list. CDC_TALLY_URL still pins one, as before.
    [string]$TallyUrl  = "",
    [string]$TallyUrls = "http://127.0.0.1:9019,http://127.0.0.1:9001",
    [string]$IngestUrl   = $env:CDC_INGEST_URL,     # falls back to the env var
    [string]$IngestToken = $env:CDC_INGEST_TOKEN,
    [string]$Branches    = "kol,ahm"                # which branch(es) THIS machine syncs (e.g. "kol").
)                                                   #   Each Tally box should sync only the company it has loaded.

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$extract = Join-Path $here "TallyToJson.ps1"
$loader  = Join-Path (Split-Path $here -Parent) "server\loader.js"
$outDir  = Join-Path $here "tally_export"
$logDir  = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $outDir,$logDir | Out-Null
$log = Join-Path $logDir ("run_" + (Get-Date).ToString('yyyyMMdd_HHmmss') + ".log")
function Say($m){ $line = "[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $m; Write-Host $line; Add-Content -Path $log -Value $line }

# Branch -> Tally company name (must match Tally EXACTLY, including punctuation/spacing).
# NOTE: PowerShell variable names are case-insensitive, so this array must NOT be
# named $branches -- that would collide with the -Branches parameter above.
$branchDefs = @(
    @{ Branch = 'kol'; Company = 'CDC PRINTERS 2025-26' }
    @{ Branch = 'ahm'; Company = 'CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26' }
)
# Keep only the branch(es) this machine is responsible for. Each Tally box only
# has ITS OWN company loaded; pulling the other branch here returns ~empty and
# just wastes a request (and, if it returned data, could clash with the box that
# owns it). Set -Branches / CDC_BRANCHES to "kol" on the Kol box, "ahm" on Ahm.
# The env var is a DEFAULT, not an override: what you typed on the command line has
# to win, or -Branches ahm silently runs kol too and the log contradicts the command.
if ($env:CDC_BRANCHES -and -not $PSBoundParameters.ContainsKey('Branches')) { $Branches = $env:CDC_BRANCHES }
$want = @($Branches.ToLower() -split '[,;\s]+' | Where-Object { $_ })
$syncBranches = @($branchDefs | Where-Object { $want -contains $_.Branch })
if ($syncBranches.Count -eq 0) { throw "No valid branch in -Branches '$Branches' (expected kol and/or ahm)." }

$to   = (Get-Date)
$from = $to.AddDays(-1 * [math]::Max(0, $TrailingDays - 1))
$FromDate = $from.ToString('yyyyMMdd')
$ToDate   = $to.ToString('yyyyMMdd')

# Decide push path once.
$ingestUrl   = $IngestUrl
$ingestToken = $IngestToken
$mongoUri    = $env:MONGODB_URI
$hasNode     = [bool](Get-Command node -ErrorAction SilentlyContinue)
$mode = if ($ingestUrl) { 'api' } elseif ($hasNode -and $mongoUri) { 'loader' } else { 'files' }

# Incremental (ALTERID) sync scans from -SyncFromDate each run so backdated
# entries/edits/deletions anywhere in that window are caught -- needs the API.
if ($Incremental -and -not $ingestUrl) { Say "Incremental requires -IngestUrl / CDC_INGEST_URL; falling back to full pull."; $Incremental = $false }

Say ("run_daily start  range {0}..{1}  mode={2}  incremental={3}  branches={4}" -f $FromDate, $ToDate, $mode, [bool]$Incremental, (($syncBranches | ForEach-Object { $_.Branch }) -join ','))

# ---- which Tally is serving which company? ---------------------------------
# Asking beats assuming: the port a branch lives on moves about, and pulling from
# the wrong one either returns nothing (the MinLedgers guard then refuses, as it
# should) or, on a shared box, somebody else's books. TallyToJson does the lookup
# -- one implementation, free to be right in one place -- and reports it as JSON.
#
# FIRST PORT WINS. A company open on both ports is the same company either way, so
# it is pulled once, from whichever answered first.
$urls = @()
if ($TallyUrl) { $urls = @($TallyUrl) }                       # pinned: ask no further
elseif ($env:CDC_TALLY_URL) { $urls = @($env:CDC_TALLY_URL) }
else { $urls = @($TallyUrls -split '[,;\s]+' | Where-Object { $_ }) }

$servedBy = @{}
foreach ($u in $urls) {
    $found = @()
    try {
        $raw = & powershell -ExecutionPolicy Bypass -File $extract -ListCompaniesJson -TallyUrl $u 2>$null
        if ($raw) { $found = @($raw | ConvertFrom-Json) }
    } catch { $found = @() }
    if (-not $found -or $found.Count -eq 0) { Say ("  {0}: no company answered" -f $u); continue }
    foreach ($r in $found) {
        $nm = "$($r.Company)"
        if (-not $nm) { continue }
        if ($servedBy.ContainsKey($nm)) {
            Say ("  {0}: also serves '{1}' -- already taken from {2}, pulling it once" -f $u, $nm, $servedBy[$nm])
        } else {
            $servedBy[$nm] = $u
            Say ("  {0}: serves '{1}'" -f $u, $nm)
        }
    }
}
if ($servedBy.Count -eq 0) { throw ("No Tally answered on {0}. Is Tally open at 'Gateway of Tally', and is its port one of these? (F1 > Settings > Connectivity)" -f ($urls -join ', ')) }


foreach ($b in $syncBranches) {
    Say ("--- branch {0} ({1}) ---" -f $b.Branch, $b.Company)
    # No port is serving this company, so there is nothing to pull. Skipping says so
    # and leaves the other branch alone; pulling anyway would return an empty master
    # and lean on the MinLedgers guard to stop it, which is a guard, not a plan.
    if (-not $servedBy.ContainsKey($b.Company)) {
        Say ("  not open on any of {0} -- skipped. Open it in Tally (Alt+F3 > Select Company) and re-run." -f ($urls -join ', '))
        continue
    }
    $TallyUrl = $servedBy[$b.Company]
    Say ("  pulling from {0}" -f $TallyUrl)
    try {
        if ($Incremental) {
            & powershell -ExecutionPolicy Bypass -File $extract `
                -Incremental -FromDate $SyncFromDate -ToDate $ToDate -Branch $b.Branch -Company $b.Company `
                -TallyUrl $TallyUrl -OutDir $outDir `
                -IngestUrl $ingestUrl -IngestToken $ingestToken 2>&1 | ForEach-Object { Say $_ }
        }
        elseif ($mode -eq 'api') {
            & powershell -ExecutionPolicy Bypass -File $extract `
                -FromDate $FromDate -ToDate $ToDate -Branch $b.Branch -Company $b.Company `
                -TallyUrl $TallyUrl -OutDir $outDir `
                -IngestUrl $ingestUrl -IngestToken $ingestToken 2>&1 | ForEach-Object { Say $_ }
        }
        else {
            & powershell -ExecutionPolicy Bypass -File $extract `
                -FromDate $FromDate -ToDate $ToDate -Branch $b.Branch -Company $b.Company `
                -TallyUrl $TallyUrl -OutDir $outDir 2>&1 | ForEach-Object { Say $_ }
            if ($mode -eq 'loader') {
                Say ("pushing {0} to Mongo via loader.js" -f $b.Branch)
                & node $loader --dir $outDir --branch $b.Branch 2>&1 | ForEach-Object { Say $_ }
            } else {
                Say "WARN: no CDC_INGEST_URL and no Node+MONGODB_URI - JSON written but NOT pushed."
            }
        }
    } catch {
        Say ("ERROR on branch {0}: {1}" -f $b.Branch, $_.Exception.Message)
    }
}
Say "run_daily done"
