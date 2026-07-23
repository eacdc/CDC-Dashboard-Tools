<#
    diag_tally.ps1 -- one-shot Tally gateway diagnostic.
    Run on the Tally box:  powershell -ExecutionPolicy Bypass -File .\pipeline\diag_tally.ps1
    Optionally:            ... -Port 9000
    Paste the WHOLE output back. It reports:
      1. Which port (9000/9001) is actually listening.
      2. The raw company-list response from Tally.
      3. For every company name found (and the two expected CDC names), how many
         ledgers Tally returns for it -- the name with thousands of ledgers is the
         exact string to use for that branch.
    KEEP PURE ASCII (PowerShell 5.1).
#>
param([int]$Port = 9001)

try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$Url = "http://localhost:$Port"
function Post([string]$body) {
    (Invoke-WebRequest -Uri $Url -Method Post -Body $body -ContentType "text/xml;charset=utf-8" -UseBasicParsing).Content
}

Write-Host "=== 1. Port test (is the Tally gateway listening?) ==="
foreach ($p in 9001, 9000) {
    $ok = $false
    try { $ok = (Test-NetConnection localhost -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
    Write-Host ("   localhost:{0}  ->  {1}" -f $p, $ok)
}
Write-Host ("   netstat for :{0} ->" -f $Port)
netstat -ano | Select-String (":" + $Port) | ForEach-Object { Write-Host ("     " + $_.ToString().Trim()) }
Write-Host ("   Using {0} for the queries below." -f $Url)

Write-Host ""
Write-Host "=== 2. Company list (raw response) ==="
$cmpBody = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Cmp</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="Cmp" ISMODIFY="No"><TYPE>Company</TYPE><NATIVEMETHOD>NAME</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
$raw = ""
try { $raw = Post $cmpBody; Write-Host ("   length = {0}" -f $raw.Length); Write-Host $raw }
catch { Write-Host ("   ERROR: {0}" -f $_.Exception.Message); Write-Host "   -> the gateway is not reachable on this port. Fix step 1 first."; return }

# Candidate names from any <NAME ...>..</NAME> tag in the response.
$names = @()
foreach ($m in [regex]::Matches($raw, '<NAME[^>]*>(.*?)</NAME>')) { $names += $m.Groups[1].Value }
$names = @($names | Where-Object { $_ } | Select-Object -Unique)

Write-Host ""
Write-Host "=== 3. Ledger count per company name (the real test) ==="
function LedgerCount([string]$company) {
    $b = @"
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>LL</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>$company</SVCURRENTCOMPANY><SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="LL" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>
"@
    try { $rr = Post $b; return ([regex]::Matches($rr, '<LEDGER[ >]')).Count } catch { return -1 }
}
$expected = @('CDC PRINTERS 2025-26', 'CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26')
$all = @($names + $expected | Select-Object -Unique)
foreach ($n in $all) {
    $tag = if ($expected -contains $n) { '(expected) ' } else { '(from Tally) ' }
    Write-Host ("   {0}[{1}]  ->  {2} ledgers" -f $tag, $n, (LedgerCount $n))
}
Write-Host ""
Write-Host "Done. The name with thousands of ledgers is the correct SVCURRENTCOMPANY for that branch."
