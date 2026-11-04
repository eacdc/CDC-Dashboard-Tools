<#
    StartTally.ps1 -- keep Tally open and ANSWERING, so the sync never waits for a human.
    ---------------------------------------------------------------------------------
    The incremental sync needs two things that a reboot takes away:

      1. Tally running, with the company loaded.
      2. Its HTTP gateway answering on 127.0.0.1.

    Without them run_daily still fires every 30 minutes and logs "no company
    answered" -- the dashboard then quietly shows yesterday's figures, which is worse
    than an error, because nothing looks broken. This script is what Task Scheduler
    runs at logon and then every few minutes: it asks the gateway whether a company is
    open, and if nothing answers it STARTS TALLY ITSELF and waits for it to come up.

    It is safe to run as often as you like -- when Tally is already answering it does
    nothing but write one line to the log.

    WHAT IT WILL NOT DO. It cannot click. If Tally opens with no company loaded, or
    sits on a licence/activation screen, no amount of launching helps -- so it says
    exactly that in the log, and the cure is one setting inside Tally (auto-load the
    company on startup; see SETUP.md). It also will not kill a running Tally unless you
    pass -RestartWedged, because a Tally with an unsaved voucher on screen must not be
    killed by a scheduled task that nobody is watching.

    KEEP PURE ASCII (PowerShell 5.1).

    RUN:
      powershell -ExecutionPolicy Bypass -File .\StartTally.ps1
      powershell -ExecutionPolicy Bypass -File .\StartTally.ps1 -NoLaunch
                                     ^ report only: start nothing, change nothing
      powershell -ExecutionPolicy Bypass -File .\StartTally.ps1 -ExpectCompany "CDC PRINTERS"
                                     ^ also warn if THAT company is not among the open ones
      powershell -ExecutionPolicy Bypass -File .\StartTally.ps1 -RestartWedged
                                     ^ Tally running but its gateway dead: kill and relaunch
                                       (can lose an unsaved Tally screen -- opt-in only)

    Environment defaults (set once, machine-level, so the scheduled task inherits them):
      CDC_TALLY_EXE        full path to tally.exe, if it is not in a usual place
      CDC_TALLY_URL        pins ONE gateway address; goes to the FRONT of the probe list
      CDC_EXPECT_COMPANY   same as -ExpectCompany

    EXIT CODES (Task Scheduler shows the last one in its History tab):
      0  a company is open and answering
      2  Tally is not running and no tally.exe could be found to launch
      3  answering, but -ExpectCompany is not among the open companies
      4  launched, but no company answered within -WaitSeconds
      5  Tally IS running yet its gateway is silent (wedged, or no company loaded)
#>
param(
    [string]$TallyExe      = "",
    # Both usual ports, as run_daily.ps1 probes them: on a shared or RDP box the two
    # branches often sit behind different ports.
    [string]$TallyUrls     = "http://127.0.0.1:9019,http://127.0.0.1:9001",
    [string]$ExpectCompany = "",
    [int]$WaitSeconds      = 240,
    [int]$PollSeconds      = 10,
    [switch]$RestartWedged,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$extract = Join-Path $here "TallyToJson.ps1"
$logDir  = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ONE rolling log, not one file per run: this runs every few minutes, and a folder with
# two hundred files a day in it is a folder nobody opens.
$log     = Join-Path $logDir "watchdog.log"
$exeMemo = Join-Path $logDir "tally_exe.txt"
if (Test-Path $log) {
    try {
        if ((Get-Item $log).Length -gt 1MB) {
            $keep = Get-Content $log -Tail 2000
            Set-Content -Path $log -Value $keep -Encoding ASCII
        }
    } catch { }
}
function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    try { Add-Content -Path $log -Value $line } catch { }
}

if ($env:CDC_EXPECT_COMPANY -and -not $PSBoundParameters.ContainsKey('ExpectCompany')) {
    $ExpectCompany = $env:CDC_EXPECT_COMPANY
}

# localhost resolves to the IPv6 loopback first on Windows, and Tally answers over IPv4
# far more reliably -- an IPv6 request can leave its socket in CLOSE_WAIT and wedge the
# listener until Tally is restarted. Same correction as run_daily.ps1 makes, and said
# out loud for the same reason.
function Fix-Loopback([string]$u) {
    if ($u -match '^(https?://)(localhost)(:\d+)?(/.*)?$') {
        $fixed = $u -replace '://localhost', '://127.0.0.1'
        Say ("  {0} -> {1} (localhost resolves to IPv6 first, which wedges Tally)" -f $u, $fixed)
        return $fixed
    }
    return $u
}

$urls = @()
if ($env:CDC_TALLY_URL) { $urls += (Fix-Loopback $env:CDC_TALLY_URL) }
foreach ($u in ($TallyUrls -split '[,;\s]+' | Where-Object { $_ })) { $urls += (Fix-Loopback $u) }
$urls = @($urls | Select-Object -Unique)

# Which companies does a port report? Asked through TallyToJson.ps1 -ListCompaniesJson,
# the same way run_daily.ps1 asks -- a second implementation of this lookup, free to
# drift from the first, is exactly what should not exist.
function Probe([string]$u) {
    $found = @()
    try {
        $raw = & powershell -ExecutionPolicy Bypass -NoProfile -File $extract -ListCompaniesJson -TallyUrl $u 2>$null
        $txt = ($raw | Out-String).Trim()
        if ($txt) {
            # PowerShell 5.1's ConvertFrom-Json hands a JSON array back as ONE object
            # rather than emitting its rows, and @() then wraps that instead of
            # unrolling it -- so every company name would arrive joined into one
            # impossible string. Flatten it here, as run_daily.ps1 does.
            foreach ($x in @(ConvertFrom-Json $txt)) {
                if ($x -is [System.Collections.IEnumerable] -and $x -isnot [string]) { $found += @($x) }
                else { $found += $x }
            }
        }
    } catch { $found = @() }
    return @($found | ForEach-Object { "$($_.Company)" } | Where-Object { $_ })
}

function OpenCompanies {
    $all = @()
    foreach ($u in $urls) {
        $c = Probe $u
        if ($c.Count -gt 0) {
            foreach ($n in $c) { Say ("  {0}: serves '{1}'" -f $u, $n) }
            $all += $c
        }
    }
    return @($all | Select-Object -Unique)
}

function TallyProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^tally' })
}

# A Tally that IS running tells us where it lives, which is worth more than any list of
# guessed install paths: remember it, and the next reboot launches exactly this one even
# on an unusual install.
function RememberExe {
    foreach ($p in (TallyProcesses)) {
        $path = $null
        try { $path = $p.Path } catch { $path = $null }
        if ($path -and (Test-Path $path)) {
            $prev = ""
            if (Test-Path $exeMemo) { try { $prev = (Get-Content $exeMemo -First 1).Trim() } catch { $prev = "" } }
            if ($prev -ne $path) {
                try {
                    Set-Content -Path $exeMemo -Value $path -Encoding ASCII
                    Say ("  remembered this Tally for the next restart: {0}" -f $path)
                } catch { }
            }
            return $path
        }
    }
    return $null
}

function FindExe {
    if ($TallyExe) {
        if (Test-Path $TallyExe) { return $TallyExe }
        Say ("  -TallyExe '{0}' does not exist -- looking elsewhere." -f $TallyExe)
    }
    if ($env:CDC_TALLY_EXE -and (Test-Path $env:CDC_TALLY_EXE)) { return $env:CDC_TALLY_EXE }
    if (Test-Path $exeMemo) {
        $memo = ""
        try { $memo = (Get-Content $exeMemo -First 1).Trim() } catch { $memo = "" }
        if ($memo -and (Test-Path $memo)) { Say ("  using the Tally remembered from an earlier run: {0}" -f $memo); return $memo }
    }
    $pf   = $env:ProgramFiles
    $pf86 = ${env:ProgramFiles(x86)}
    $cands = @()
    foreach ($root in @($pf, $pf86)) {
        if (-not $root) { continue }
        $cands += (Join-Path $root "TallyPrime\tally.exe")
        $cands += (Join-Path $root "Tally Solutions\TallyPrime\tally.exe")
        $cands += (Join-Path $root "TallyPrime Edit Log\tally.exe")
        $cands += (Join-Path $root "Tally.ERP9\tally.exe")
    }
    $cands += "C:\TallyPrime\tally.exe"
    $cands += "C:\Program Files\TallyPrime\tally.exe"
    $cands += "C:\Tally.ERP9\tally.exe"
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

Say ("watchdog start  probing {0}" -f ($urls -join ', '))

# ---- already healthy? -------------------------------------------------------
$open = OpenCompanies
if ($open.Count -gt 0) {
    RememberExe | Out-Null
    if ($ExpectCompany -and -not ($open | Where-Object { $_ -like ("*" + $ExpectCompany + "*") })) {
        Say ("WARN: '{0}' is not open. What IS open: {1}" -f $ExpectCompany, (($open | ForEach-Object { "'" + $_ + "'" }) -join ', '))
        Say  "      The sync will skip that branch, so this is a real problem, not a cosmetic one."
        Say  "      Open it in Tally (Alt+F3 > Select Company), then set it to load on startup (see SETUP.md)."
        exit 3
    }
    Say ("OK: {0} company/companies open and answering -- nothing to do." -f $open.Count)
    exit 0
}

# ---- nothing answered -------------------------------------------------------
$procs = TallyProcesses
if ($procs.Count -gt 0) {
    Say ("Tally IS running (pid {0}) but no company answered on {1}." -f (($procs | ForEach-Object { $_.Id }) -join ', '), ($urls -join ', '))
    RememberExe | Out-Null
    if (-not $RestartWedged) {
        Say  "  One of three things, and the log cannot tell them apart from here:"
        Say  "    a) NO COMPANY IS LOADED -- Tally is sitting at the company-select screen."
        Say  "       Open it once (Alt+F3 > Select Company) and set it to load on startup, or every"
        Say  "       reboot will need a human again."
        Say  "    b) THE GATEWAY IS OFF or on another port (F1 > Settings > Connectivity)."
        Say  "    c) THE LISTENER IS WEDGED -- an IPv6 request left a socket in CLOSE_WAIT. Only a"
        Say  "       Tally restart frees it. Check: netstat -ano | findstr :9019"
        Say  "  Not touching it: a running Tally may have an unsaved voucher on screen, and a"
        Say  "  scheduled task nobody is watching must not kill that. Pass -RestartWedged if you"
        Say  "  want this script to restart it anyway."
        exit 5
    }
    Say  "  -RestartWedged given: stopping Tally and relaunching. An unsaved Tally screen is lost."
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.Id -Force; Say ("  stopped pid {0}" -f $p.Id) }
        catch { Say ("  could not stop pid {0}: {1}" -f $p.Id, $_.Exception.Message) }
    }
    Start-Sleep -Seconds 5
}
else {
    Say "Tally is not running (this is what a reboot leaves behind)."
}

if ($NoLaunch) { Say "-NoLaunch given: starting nothing."; exit 4 }

$exe = FindExe
if (-not $exe) {
    Say "ERROR: no tally.exe found, so there is nothing to launch."
    Say  "  Set the path once and this is solved for good:"
    Say  '    setx CDC_TALLY_EXE "C:\Program Files\TallyPrime\tally.exe"   (use YOUR path)'
    Say  "  Right-click the Tally shortcut > Properties > Target to read it off."
    exit 2
}

Say ("launching {0}" -f $exe)
try {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null
} catch {
    Say ("ERROR: could not start it: {0}" -f $_.Exception.Message)
    exit 2
}

# Tally needs a while -- splash, licence check, then the company. Poll rather than
# guess at a sleep.
$waited = 0
while ($waited -lt $WaitSeconds) {
    Start-Sleep -Seconds $PollSeconds
    $waited += $PollSeconds
    $open = OpenCompanies
    if ($open.Count -gt 0) {
        Say ("OK: answering after {0}s -- {1} company/companies open." -f $waited, $open.Count)
        if ($ExpectCompany -and -not ($open | Where-Object { $_ -like ("*" + $ExpectCompany + "*") })) {
            Say ("WARN: '{0}' is still not among them." -f $ExpectCompany)
            exit 3
        }
        exit 0
    }
    Say ("  {0}s: still nothing." -f $waited)
}

Say ("ERROR: Tally was launched but no company answered within {0}s." -f $WaitSeconds)
Say  "  Almost always ONE of these, and both are a Tally setting, not a script problem:"
Say  "    1. No company loads on startup. Set it inside Tally so a reboot needs no human."
Say  "    2. It is waiting on a licence/activation screen. Nothing automated gets past that."
Say  "  Look at the screen once; after that it stays fixed."
exit 4
