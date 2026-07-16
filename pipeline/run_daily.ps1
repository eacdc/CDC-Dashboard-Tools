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

    RUN:  powershell -ExecutionPolicy Bypass -File .\run_daily.ps1
          powershell -ExecutionPolicy Bypass -File .\run_daily.ps1 -TrailingDays 7
#>
param(
    [int]$TrailingDays = 1,                         # 1 = today only; 7 = re-pull last week (catches edits)
    [string]$TallyUrl  = "http://localhost:9001"
)

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$extract = Join-Path $here "TallyToJson.ps1"
$loader  = Join-Path (Split-Path $here -Parent) "server\loader.js"
$outDir  = Join-Path $here "tally_export"
$logDir  = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $outDir,$logDir | Out-Null
$log = Join-Path $logDir ("run_" + (Get-Date).ToString('yyyyMMdd_HHmmss') + ".log")
function Say($m){ $line = "[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $m; Write-Host $line; Add-Content -Path $log -Value $line }

# Branch -> Tally company name. Add Ahmedabad once its exact company name is known.
$branches = @(
    @{ Branch = 'kol'; Company = 'CDC PRINTERS 2025-26' }
    # @{ Branch = 'ahm'; Company = 'CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26' }   # <-- fill in exact name
)

$to   = (Get-Date)
$from = $to.AddDays(-1 * [math]::Max(0, $TrailingDays - 1))
$FromDate = $from.ToString('yyyyMMdd')
$ToDate   = $to.ToString('yyyyMMdd')

# Decide push path once.
$ingestUrl   = $env:CDC_INGEST_URL
$ingestToken = $env:CDC_INGEST_TOKEN
$mongoUri    = $env:MONGODB_URI
$hasNode     = [bool](Get-Command node -ErrorAction SilentlyContinue)
$mode = if ($ingestUrl) { 'api' } elseif ($hasNode -and $mongoUri) { 'loader' } else { 'files' }

Say ("run_daily start  range {0}..{1}  mode={2}" -f $FromDate, $ToDate, $mode)

foreach ($b in $branches) {
    Say ("--- branch {0} ({1}) ---" -f $b.Branch, $b.Company)
    try {
        if ($mode -eq 'api') {
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
