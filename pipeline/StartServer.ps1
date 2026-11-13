<#
    StartServer.ps1 -- keep the local CDC API server (npm start in ..\server) running.
    ---------------------------------------------------------------------------------
    Task Scheduler runs this at logon and then every few minutes. It asks
    http://127.0.0.1:<port>/health; if nothing answers, it starts "npm start" in the
    server folder in its own minimised window, with output appended to
    logs\server.log. When the server is already up it only writes one log line.

    KEEP PURE ASCII (PowerShell 5.1).

    RUN:
      powershell -ExecutionPolicy Bypass -File .\StartServer.ps1
      powershell -ExecutionPolicy Bypass -File .\StartServer.ps1 -NoLaunch   (report only)

    EXIT CODES: 0 answering, 2 npm/server folder not found, 4 started but not answering.
#>
param(
    [int]$Port        = 0,
    [string]$ServerDir = "",
    [int]$WaitSeconds = 90,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log    = Join-Path $logDir "server_watchdog.log"
$outLog = Join-Path $logDir "server.log"
function Say($m) {
    $line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    try { Add-Content -Path $log -Value $line } catch { }
}
foreach ($f in @($log, $outLog)) {
    try { if ((Test-Path $f) -and (Get-Item $f).Length -gt 5MB) {
        Set-Content -Path $f -Value (Get-Content $f -Tail 2000) -Encoding ASCII } } catch { }
}

if (-not $ServerDir) { $ServerDir = Join-Path (Split-Path -Parent $here) "server" }
if ($Port -le 0) {
    $Port = 3000
    if ($env:PORT) { $Port = [int]$env:PORT }
    $envFile = Join-Path $ServerDir ".env"
    if (-not $env:PORT -and (Test-Path $envFile)) {
        $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*"?(\d+)' | Select-Object -First 1
        if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
    }
}
$health = "http://127.0.0.1:{0}/health" -f $Port

function Up {
    try {
        $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 10
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        # A 503 (e.g. Mongo not yet connected) still means the process is listening.
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

if (Up) { Say ("OK: server answering on {0} -- nothing to do." -f $health); exit 0 }
Say ("server not answering on {0}." -f $health)
if ($NoLaunch) { Say "-NoLaunch given: starting nothing."; exit 4 }

if (-not (Test-Path (Join-Path $ServerDir "package.json"))) {
    Say ("ERROR: no package.json in {0}. Pass -ServerDir." -f $ServerDir); exit 2
}
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npm) {
    foreach ($c in @("$env:ProgramFiles\nodejs\npm.cmd", "${env:ProgramFiles(x86)}\nodejs\npm.cmd", "$env:APPDATA\npm\npm.cmd")) {
        if ($c -and (Test-Path $c)) { $npm = Get-Item $c; break }
    }
}
if (-not $npm) { Say "ERROR: npm not found. Is Node.js installed for this user?"; exit 2 }
$npmPath = if ($npm.Source) { $npm.Source } else { $npm.FullName }

if (-not (Test-Path (Join-Path $ServerDir "node_modules"))) {
    Say "node_modules missing -- running npm install first."
    & cmd /c "cd /d `"$ServerDir`" && `"$npmPath`" install --omit=dev >> `"$outLog`" 2>&1"
}

Say ("starting: npm start in {0} (output -> {1})" -f $ServerDir, $outLog)
Add-Content -Path $outLog -Value ("==== started {0} ====" -f (Get-Date))
$cmdLine = "/c title CDC Server && `"$npmPath`" start >> `"$outLog`" 2>&1"
Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WorkingDirectory $ServerDir -WindowStyle Minimized | Out-Null

$waited = 0
while ($waited -lt $WaitSeconds) {
    Start-Sleep -Seconds 5; $waited += 5
    if (Up) { Say ("OK: server answering after {0}s." -f $waited); exit 0 }
}
Say ("ERROR: started but nothing answered within {0}s. Read {1}." -f $WaitSeconds, $outLog)
exit 4
