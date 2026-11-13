<#
    Install-CdcAutostart.ps1 -- register the two scheduled tasks that make this box
    pick itself up after a restart, with nobody standing at the keyboard.
    -----------------------------------------------------------------------------
    It creates (or replaces) two tasks:

      CDC_Tally_Watchdog    at logon, then every -WatchdogMinutes (default 10)
                            -> StartTally.ps1: is a company answering? if not, start Tally.

      CDC_Tally_Sync_30min  at logon + -SyncDelayMinutes, then every -SyncMinutes (30)
                            -> run_sync.bat -Branches <this box's branch>

    Both are registered to run AS YOU, "only when logged on" (LogonType Interactive).
    That is not a shortcut -- Tally is a desktop application with no service mode, so a
    task set to "run whether the user is logged on or not" gets no desktop to talk to
    and finds no Tally at all. Which is why the ONE manual thing left is Windows
    auto-login; this script prints the steps at the end.

    Why "at logon" and not only "on a schedule": a plain schedule trigger survives a
    reboot only if the box is back up at the next fire time and somebody has logged in.
    An at-logon trigger fires the moment the session exists, so the gap after a restart
    is minutes, not hours.

    Why MultipleInstances=IgnoreNew: the weekly sweep re-reads seventeen months and
    takes hours. Without this, a 30-minute trigger would stack a dozen overlapping runs
    on top of it and hammer the same Tally.

    KEEP PURE ASCII (PowerShell 5.1).

    RUN (once, in an ADMINISTRATOR PowerShell, on the Tally box):
      powershell -ExecutionPolicy Bypass -File .\Install-CdcAutostart.ps1 -Branches kol
      powershell -ExecutionPolicy Bypass -File .\Install-CdcAutostart.ps1 -Branches ahm
      powershell -ExecutionPolicy Bypass -File .\Install-CdcAutostart.ps1 -Remove
#>
param(
    # Which branch THIS machine syncs. Required on purpose: -Branches is the guard that
    # keeps one company's vouchers out of the other branch, and a default that quietly
    # syncs both is how that guard gets lost.
    [string]$Branches         = "",
    [int]$SyncMinutes         = 30,
    [int]$WatchdogMinutes     = 10,
    # The sync waits a few minutes after logon so the watchdog has Tally up first.
    [int]$SyncDelayMinutes    = 4,
    # Also keep the local API server (npm start in ..\server) running. Pass -NoServer
    # on a box whose sync posts to a hosted server instead.
    [switch]$NoServer,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $here "StartTally.ps1"
$syncBat  = Join-Path $here "run_sync.bat"
$serverPs = Join-Path $here "StartServer.ps1"
$WATCH_TASK = "CDC_Tally_Watchdog"
$SYNC_TASK  = "CDC_Tally_Sync_30min"
$SERVER_TASK = "CDC_Server_Watchdog"

function Say($m) { Write-Host $m }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Remove) {
    foreach ($t in @($WATCH_TASK, $SYNC_TASK, $SERVER_TASK)) {
        try {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop
            Say ("removed {0}" -f $t)
        } catch {
            Say ("{0}: not registered (nothing to remove)" -f $t)
        }
    }
    Say ""
    Say "Done. This box will no longer start Tally or sync by itself."
    return
}

if (-not $isAdmin) {
    throw "Run this in an ADMINISTRATOR PowerShell -- registering a scheduled task needs it."
}
if (-not (Test-Path $watchdog)) { throw ("StartTally.ps1 not found next to this script ({0})." -f $watchdog) }
if (-not (Test-Path $syncBat))  { throw ("run_sync.bat not found next to this script ({0})." -f $syncBat) }

if (-not $Branches) {
    if ($env:CDC_BRANCHES) {
        $Branches = $env:CDC_BRANCHES
        Say ("-Branches not given; using CDC_BRANCHES from the environment: {0}" -f $Branches)
    } else {
        throw ("Pass -Branches kol (Kolkata box) or -Branches ahm (Ahmedabad box). " +
               "Each Tally box has only its own company loaded, and syncing the wrong one " +
               "is how a branch ends up holding the other branch's vouchers.")
    }
}
$want = @($Branches.ToLower() -split '[,;\s]+' | Where-Object { $_ })
foreach ($b in $want) {
    if ($b -ne 'kol' -and $b -ne 'ahm') { throw ("'{0}' is not a branch -- expected kol and/or ahm." -f $b) }
}
$Branches = ($want -join ',')

if ($SyncMinutes -lt 1 -or $WatchdogMinutes -lt 1) { throw "-SyncMinutes and -WatchdogMinutes must be at least 1." }

$me = "{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME
$ps = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $ps)) { $ps = "powershell.exe" }

# A logon trigger that then repeats forever. Repetition is not a parameter of
# New-ScheduledTaskTrigger -AtLogOn, so it is lifted off a -Once trigger -- the
# documented way round it in PowerShell 5.1.
function LogonTriggerEvery([int]$minutes, [int]$delayMinutes) {
    $t = New-ScheduledTaskTrigger -AtLogOn -User $me
    # 3650 days, not TimeSpan::MaxValue: "indefinitely" is what the GUI calls this, but
    # MaxValue is rejected outright on some Windows builds.
    $rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
              -RepetitionInterval (New-TimeSpan -Minutes $minutes) `
              -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
    $t.Repetition = $rep
    if ($delayMinutes -gt 0) { $t.Delay = ("PT{0}M" -f $delayMinutes) }
    return $t
}

$settings = New-ScheduledTaskSettingsSet `
                -MultipleInstances IgnoreNew `
                -StartWhenAvailable `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
                -ExecutionTimeLimit (New-TimeSpan -Hours 12)

# Interactive, as me: Tally is a desktop app and has no service mode. RunLevel stays
# Limited -- none of this needs administrator once the tasks exist.
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

$watchArg   = '-ExecutionPolicy Bypass -NoProfile -File "' + $watchdog + '"'
$watchAction = New-ScheduledTaskAction -Execute $ps -Argument $watchArg -WorkingDirectory $here
$syncAction  = New-ScheduledTaskAction -Execute $syncBat -Argument ("-Branches " + $Branches) -WorkingDirectory $here

Register-ScheduledTask -TaskName $WATCH_TASK -Force `
    -Action $watchAction -Trigger (LogonTriggerEvery $WatchdogMinutes 0) `
    -Settings $settings -Principal $principal `
    -Description "Starts Tally if its gateway is not answering, so the CDC sync never waits for a human." | Out-Null
Say ("registered {0}  -- at logon, then every {1} min" -f $WATCH_TASK, $WatchdogMinutes)

Register-ScheduledTask -TaskName $SYNC_TASK -Force `
    -Action $syncAction -Trigger (LogonTriggerEvery $SyncMinutes $SyncDelayMinutes) `
    -Settings $settings -Principal $principal `
    -Description ("CDC incremental Tally -> MongoDB sync for branch(es) " + $Branches + ".") | Out-Null
Say ("registered {0}   -- at logon +{1} min, then every {2} min, branches={3}" -f $SYNC_TASK, $SyncDelayMinutes, $SyncMinutes, $Branches)

if (-not $NoServer) {
    if (-not (Test-Path $serverPs)) { throw ("StartServer.ps1 not found next to this script ({0})." -f $serverPs) }
    $serverArg = '-ExecutionPolicy Bypass -NoProfile -File "' + $serverPs + '"'
    $serverAction = New-ScheduledTaskAction -Execute $ps -Argument $serverArg -WorkingDirectory $here
    Register-ScheduledTask -TaskName $SERVER_TASK -Force `
        -Action $serverAction -Trigger (LogonTriggerEvery $WatchdogMinutes 0) `
        -Settings $settings -Principal $principal `
        -Description "Starts the CDC API server (npm start) if it is not answering /health." | Out-Null
    Say ("registered {0}  -- at logon, then every {1} min" -f $SERVER_TASK, $WatchdogMinutes)
    try { Start-ScheduledTask -TaskName $SERVER_TASK; Say "  server watchdog started once now (logs\server_watchdog.log)." } catch { }
}

# Run the watchdog now, so the install is proved rather than assumed.
Say ""
Say "Starting the watchdog once now..."
try {
    Start-ScheduledTask -TaskName $WATCH_TASK
    Say ("  started. Watch it work:  Get-Content `"{0}\logs\watchdog.log`" -Tail 20 -Wait" -f $here)
} catch {
    Say ("  could not start it: {0}" -f $_.Exception.Message)
}

# ---- what is still needed, said plainly -------------------------------------
Say ""
Say "----------------------------------------------------------------------"
Say "STILL TO CHECK (the tasks are in place; these three make them useful)"
Say "----------------------------------------------------------------------"

if ($env:CDC_INGEST_URL) { Say ("1. CDC_INGEST_URL  = {0}" -f $env:CDC_INGEST_URL) }
else {
    Say "1. CDC_INGEST_URL  is NOT SET -- the incremental sync CANNOT work without it."
    Say "   It falls back to writing JSON files and pushing nothing, and the log says so."
    Say '   Fix:  setx CDC_INGEST_URL "https://your-dashboard-host" /M'
}
if ($env:CDC_INGEST_TOKEN) { Say "   CDC_INGEST_TOKEN is set (value not printed)." }
else { Say "   CDC_INGEST_TOKEN is NOT SET -- set it too if the server requires a token." }
Say "   Set with /M (machine-level) and REBOOT or re-register, or the task will not see it."
Say ""
Say "2. TALLY MUST LOAD THE COMPANY BY ITSELF."
Say "   The watchdog can start Tally; it cannot click. If Tally comes up at the"
Say "   company-select screen, the gateway answers with nothing and the sync stays"
Say "   stuck -- so set the company to load on startup inside Tally, once."
Say "   Check it the honest way: restart this box, log in, touch nothing, and after"
Say "   ten minutes read logs\watchdog.log. It must say 'company/companies open'."
Say ""
Say "3. WINDOWS MUST LOG IN BY ITSELF after a restart."
Say "   Tally has no service mode, so these tasks only run inside a logged-on"
Say "   session. Until Windows logs in on its own, a reboot still needs a human."
Say "   Turn on auto-login:  run  netplwiz  > untick 'Users must enter a user name"
Say "   and password' > OK > type the password twice."
Say "   (It stores that password on this machine, so only do it on a box that is"
Say "   already physically and network protected.)"
Say ""
Say "   ON AN RDP BOX: DISCONNECT, DO NOT SIGN OUT. Closing the window with X keeps"
Say "   the session -- and Tally -- running. 'Sign out' kills Tally, and then the"
Say "   watchdog cannot help, because there is no session left to start it in."
Say ""
Say "Both tasks are in Task Scheduler as CDC_Tally_Watchdog and CDC_Tally_Sync_30min."
Say "Undo everything:  powershell -ExecutionPolicy Bypass -File .\Install-CdcAutostart.ps1 -Remove"
