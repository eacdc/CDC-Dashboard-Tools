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
          powershell -ExecutionPolicy Bypass -File .\run_daily.ps1 -From 20260101 -To 20260331
                                                  ^ re-pull one window in full, however far back
          powershell -ExecutionPolicy Bypass -File .\run_daily.ps1 -Incremental -Sweep
                                                  ^ run this week's full sweep now, without waiting

    THE WEEKLY SWEEP. With -Incremental, every 7th day (-SweepDays) the run is followed
    by a FULL re-read of the whole scan window. The incremental sync asks Tally what
    changed since the last run, so an edit it was never told about is invisible to it for
    ever; the sweep consults no ALTERID and so has nothing to hide behind. It only adds
    and overwrites -- deletions are the incremental's reconcile, which runs first.
#>
param(
    [int]$TrailingDays = 1,                         # full mode: 1 = today only; 7 = re-pull last week
    # Re-pull ONE window, however far back, as YYYYMMDD. The incremental sync only ever
    # revisits what Tally reports as changed SINCE the last run, so an edit that slipped
    # past once is never looked at again -- and the only cure is to pull those days in
    # full. Doing that through this script means the token stays in the environment
    # where it belongs, instead of being typed into a command line.
    # NOTE: nothing below may declare a local $from or $to. PowerShell variable names are
    # case-insensitive, so such a local IS this parameter -- see $dtFrom / $dtTo later.
    [string]$From = "",
    [string]$To   = "",
    # The weekly sweep. Every N days the incremental run is followed by a FULL re-read of
    # the whole scan window, because the incremental's blind spot is exactly an edit it
    # was never told about. 0 turns it off; -Sweep forces one now.
    [int]$SweepDays = 7,
    [switch]$Sweep,
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

# $dtTo / $dtFrom, NOT $to / $from: PowerShell variable names are case-insensitive, so
# a local $to IS the -To parameter. Named that way, -To 20260401 landed in $to and the
# next line asked a string for .AddDays(). The same trap as $branches / -Branches above,
# and the reason both carry a note.
$dtTo   = (Get-Date)
$dtFrom = $dtTo.AddDays(-1 * [math]::Max(0, $TrailingDays - 1))
$FromDate = $dtFrom.ToString('yyyyMMdd')
$ToDate   = $dtTo.ToString('yyyyMMdd')
# A named window replaces the trailing one, and turns the incremental sync off for this
# run: asking Tally what CHANGED is exactly what missed these days in the first place.
$Rescan = $false
if ($From -or $To) {
    if ($From -notmatch '^\d{8}$' -or $To -notmatch '^\d{8}$') {
        throw "-From and -To must BOTH be given as YYYYMMDD (e.g. -From 20260128 -To 20260331)."
    }
    if ($To -lt $From) { throw "-To ($To) is before -From ($From)." }
    $FromDate = $From; $ToDate = $To; $Rescan = $true
    if ($Incremental) { $Incremental = $false }
}

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
if ($Rescan) {
    Say ("  RESCAN of {0}..{1} in full -- every voucher Tally holds in those days is re-read, and each one" -f $FromDate, $ToDate)
    Say  "  overwrites the stored copy. That is what fixes a voucher edited before the sync started watching:"
    Say  "  the incremental sync only ever revisits what CHANGED since the last run, so it never looks again."
    Say  "  It only ADDS and OVERWRITES. A voucher Tally has since deleted is removed by the daily sync's own"
    Say  "  reconcile, not by this, and nothing outside the window is touched either way."
}

# ---- which Tally is serving which company? ---------------------------------
# Asking beats assuming: the port a branch lives on moves about, and pulling from
# the wrong one either returns nothing (the MinLedgers guard then refuses, as it
# should) or, on a shared box, somebody else's books. TallyToJson does the lookup
# -- one implementation, free to be right in one place -- and reports it as JSON.
#
# FIRST PORT WINS. A company open on both ports is the same company either way, so
# it is pulled once, from whichever answered first.
# localhost resolves to the IPv6 loopback first on Windows, and Tally answers over
# IPv4 far more reliably -- an IPv6 request can leave its socket in CLOSE_WAIT and
# wedge the listener until Tally is restarted. A CDC_TALLY_URL set years ago should
# not be able to reintroduce that, so the host is corrected and the correction said.
function Fix-Loopback([string]$u) {
    if ($u -match '^(https?://)(localhost)(:\d+)?(/.*)?$') {
        $fixed = $u -replace '://localhost', '://127.0.0.1'
        Say ("  {0} -> {1} (localhost resolves to IPv6 first, which wedges Tally)" -f $u, $fixed)
        return $fixed
    }
    return $u
}

# -TallyUrl on the command line is a deliberate act: pin it and ask no further. The
# ENV VAR is only a stored default -- it goes to the FRONT of the list, it does not
# replace it, or a value set once for one machine quietly cancels the search that
# found the other branch.
$urls = @()
if ($TallyUrl) { $urls = @((Fix-Loopback $TallyUrl)) }
else {
    if ($env:CDC_TALLY_URL) { $urls += (Fix-Loopback $env:CDC_TALLY_URL) }
    foreach ($u in ($TallyUrls -split '[,;\s]+' | Where-Object { $_ })) { $urls += (Fix-Loopback $u) }
    $urls = @($urls | Select-Object -Unique)
}

$servedBy = @{}
foreach ($u in $urls) {
    $found = @()
    try {
        $raw = & powershell -ExecutionPolicy Bypass -File $extract -ListCompaniesJson -TallyUrl $u 2>$null
        $txt = ($raw | Out-String).Trim()
        if ($txt) {
            # PowerShell 5.1's ConvertFrom-Json hands a JSON array back as ONE object
            # rather than emitting its rows, and @() then wraps that instead of
            # unrolling it. The foreach below runs ONCE with $r as the whole array, and
            # "$($r.Company)" member-enumerates to every company name joined by spaces:
            # one impossible company that matches no branch, so BOTH are skipped as not
            # open while they sit open on the screen. Flatten it here, once.
            foreach ($x in @(ConvertFrom-Json $txt)) {
                if ($x -is [System.Collections.IEnumerable] -and $x -isnot [string]) { $found += @($x) }
                else { $found += $x }
            }
        }
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
        # Say what the ports DID answer with. A company open on screen but missing here
        # is a name that does not match -- a stray space, a renamed year, or a list this
        # script failed to read apart -- and the two lists side by side show which at a
        # glance. Without them this reads as "Tally is not open", which sends you to
        # look at the one thing that is fine.
        Say ("  not open on any of {0} -- skipped." -f ($urls -join ', '))
        if ($servedBy.Count -gt 0) {
            Say ("  the ports answered with: {0}" -f (($servedBy.Keys | ForEach-Object { "'" + $_ + "'" }) -join ', '))
            Say  "  if one of those IS this branch, the name differs from the one in this script -- copy it in exactly."
        } else {
            Say  "  open it in Tally (Alt+F3 > Select Company) and re-run."
        }
        continue
    }
    $TallyUrl = $servedBy[$b.Company]
    Say ("  pulling from {0}" -f $TallyUrl)
    $incOk = $false
    try {
        if ($Incremental) {
            & powershell -ExecutionPolicy Bypass -File $extract `
                -Incremental -FromDate $SyncFromDate -ToDate $ToDate -Branch $b.Branch -Company $b.Company `
                -TallyUrl $TallyUrl -OutDir $outDir `
                -IngestUrl $ingestUrl -IngestToken $ingestToken 2>&1 | ForEach-Object { Say $_ }
            $incOk = ($LASTEXITCODE -eq 0)
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
        # ---- the weekly sweep --------------------------------------------------
        # The incremental sync asks Tally what changed SINCE THE LAST RUN, and that is
        # its blind spot: an edit whose ALTERID was already below the mark -- one that
        # slipped past on a dropped connection, or happened before this branch was ever
        # synced -- is never looked at again. It cost a 23,423 sale and a 2,428 journal
        # on ONE ledger, found only because somebody exported that ledger by hand.
        #
        # So once a week the whole scan window is re-read in full and every voucher
        # overwritten with what Tally holds now. ALTERID is not consulted, so there is
        # nothing for an edit to hide behind.
        #
        # It ADDS and OVERWRITES only. A voucher Tally has since DELETED is removed by
        # the incremental's own reconcile, which runs first, every day.
        # Only after a sync that worked. If the incremental just failed, Tally or the
        # server is unreachable and a full re-read of seventeen months will fail too --
        # slowly, and for the same reason.
        if ($Incremental -and $incOk -and $SweepDays -gt 0 -and -not $Rescan) {
            $stamp = Join-Path $logDir ("sweep_{0}.txt" -f $b.Branch)
            $last  = ""
            if (Test-Path $stamp) { $last = (Get-Content $stamp -First 1).Trim() }
            # Counted in days elapsed, not "is it Sunday": this machine is not always on,
            # and a sweep skipped because the box was off that night would wait a week.
            $age = 9999
            if ($last -match '^\d{8}$') {
                $lastDt = [datetime]::ParseExact($last, 'yyyyMMdd', $null)
                $age = [int]((Get-Date).Date - $lastDt.Date).TotalDays
            }
            if ($Sweep -or $age -ge $SweepDays) {
                Say ("  --- weekly sweep: re-reading {0}..{1} in full ({2}) ---" -f $SyncFromDate, $ToDate,
                     $(if ($Sweep) { "asked for with -Sweep" } elseif ($last) { "$age days since $last" } else { "never swept" }))
                Say  "  This is the ONLY thing that catches a voucher edited before the sync started watching."
                & powershell -ExecutionPolicy Bypass -File $extract `
                    -FromDate $SyncFromDate -ToDate $ToDate -Branch $b.Branch -Company $b.Company `
                    -TallyUrl $TallyUrl -OutDir $outDir `
                    -IngestUrl $ingestUrl -IngestToken $ingestToken 2>&1 | ForEach-Object { Say $_ }
                # The date is recorded ONLY when the pull actually reached Mongo. A sweep
                # that failed and still ticked itself off is worse than no sweep at all:
                # it would wait another week before trying again, with the hole intact.
                if ($LASTEXITCODE -eq 0) {
                    Set-Content -Path $stamp -Value (Get-Date).ToString('yyyyMMdd') -Encoding ASCII
                    Say ("  sweep done; next one in {0} days." -f $SweepDays)
                } else {
                    Say ("  sweep FAILED (exit {0}) -- not recorded, so the next run tries again." -f $LASTEXITCODE)
                }
            }
        }
    } catch {
        Say ("ERROR on branch {0}: {1}" -f $b.Branch, $_.Exception.Message)
    }
}
Say "run_daily done"
