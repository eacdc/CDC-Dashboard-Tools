<#
    TallyToJson.ps1
    ---------------
    Pulls Tally masters + Day Book over a date range and writes TWO JSON files in
    the exact shape the CDC dashboards consume:

        <Branch>_Master.json        { "ledgers": { name: group }, "groups": { name: parent|null } }
        <Branch>_Transactions.json  [ { date, party, no, type, ledgers:{}, party_ledgers:{} }, ... ]

    This is the JSON equivalent of the original CSV extractor (Get-TallyDayBook-CSV.ps1).
    Same gateway calls, same Tally gotchas handled (see Tally_Extraction_Documentation.md),
    but the output is the dashboard's native format instead of 7 CSVs.

    It can also POST the two files straight to the ingest API so they land in MongoDB.
    If the Tally box has no outbound internet, leave -IngestUrl empty: the files are
    written to -OutDir and a separate machine can push them with server/loader.js.

    KEEP THIS FILE PURE ASCII (PowerShell 5.1 misreads UTF-8 without BOM; see doc 5.9).

    RUN (historical backfill, 1 Apr -> today):
        powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
                   -FromDate 20250401 -ToDate 20260716 -Branch ahm `
                   -Company "CDC PRINTERS PVT LTD. (Ahmedabad) - 2025-26"

    RUN (daily incremental - just yesterday/today, appended into Mongo):
        powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
                   -FromDate 20260716 -ToDate 20260716 -Branch ahm `
                   -IngestUrl "https://your-api.onrender.com" -IngestToken "SECRET"
#>
param(
    [string]$FromDate    = "20250401",
    [string]$ToDate      = (Get-Date).ToString('yyyyMMdd'),
    [string]$TallyUrl    = "http://localhost:9001",
    [string]$Company     = "CDC PRINTERS 2025-26",
    [ValidateSet('kol','ahm')]
    [string]$Branch      = "ahm",
    [string]$OutDir      = "$env:USERPROFILE\Desktop\tally_export",
    [string]$IngestUrl   = "",           # e.g. https://cdc-api.onrender.com  (empty = write files only)
    [string]$IngestToken = "",           # shared secret; sent as x-ingest-token header
    [switch]$EmitCsv                     # also write the original 7 CSVs (off by default)
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- helpers (unchanged from the CSV extractor) ----
function xval($node) {
    if ($null -eq $node) { return "" }
    if ($node -is [System.Xml.XmlElement]) { $t = $node.InnerText } else { $t = "$node" }
    return ($t -replace "[\x00-\x1f]","").Trim()
}
function ToAmount($s) {
    $c = ("$s" -replace "[^0-9.\-]",""); $n=0.0
    [double]::TryParse($c,[ref]$n)|Out-Null; return [math]::Round($n,2)
}
function Post-Tally([string]$body) {
    $r = Invoke-WebRequest -Uri $TallyUrl -Method Post -Body $body `
         -ContentType "text/xml;charset=utf-8" -UseBasicParsing
    $s = $r.Content -replace "[\x00-\x08\x0b\x0c\x0e-\x1f]","" `
                    -replace "&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)","&amp;"
    return $s
}
# Recursively gather every (ledger, amount) posting in a voucher. This must catch
# BOTH top-level *LEDGERENTRIES.LIST AND *ACCOUNTINGALLOCATIONS.LIST: for a
# sales/purchase voucher WITH stock items, the revenue/purchase ledger lives
# nested under ALLINVENTORYENTRIES.LIST > ACCOUNTINGALLOCATIONS.LIST, not at the
# top level. Reading only top-level entries silently drops the sales/purchase
# amount (keeping just tax + party) and understates revenue/COGS.
function Collect-Postings($node, $list) {
    foreach ($c in $node.ChildNodes) {
        if ($c.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
        $nm = $c.Name
        if (($nm -like "*LEDGERENTRIES.LIST") -or ($nm -like "*ACCOUNTINGALLOCATIONS.LIST")) {
            $ln = xval $c.LEDGERNAME
            if ($ln) {
                $amt = ToAmount (xval $c.AMOUNT)   # raw Tally sign: -ve = Dr, +ve = Cr
                [void]$list.Add([PSCustomObject]@{ Ledger = $ln; Amount = $amt })
                continue   # leaf posting - don't descend into its bill/cost allocations
            }
        }
        if ($c.HasChildNodes) { Collect-Postings $c $list }
    }
}

# ======================================================================
# STEP 1 - MASTERS (ledgers + groups)
# ======================================================================
Write-Host "Pulling masters..."

$ledgerPayload = @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>LedgerList</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>$Company</SVCURRENTCOMPANY>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="LedgerList" ISMODIFY="No">
        <TYPE>Ledger</TYPE>
        <FETCH>NAME,PARENT</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@

$groupPayload = @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>GroupList</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>$Company</SVCURRENTCOMPANY>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="GroupList" ISMODIFY="No">
        <TYPE>Group</TYPE>
        <FETCH>NAME,PARENT</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@

$ledgerToGroup = @{}   # ledger name -> immediate group
$groupToParent = @{}   # group name  -> parent group (or "" at root)

[xml]$lx = Post-Tally $ledgerPayload
foreach ($l in $lx.SelectNodes("//LEDGER")) {
    $name = xval $l.NAME; if (-not $name) { continue }
    $ledgerToGroup[$name] = xval $l.PARENT
}
Write-Host ("  Ledgers : {0}" -f $ledgerToGroup.Count)

[xml]$gx = Post-Tally $groupPayload
foreach ($g in $gx.SelectNodes("//GROUP")) {
    $name = xval $g.NAME; if (-not $name) { continue }
    $groupToParent[$name] = xval $g.PARENT
}
Write-Host ("  Groups  : {0}" -f $groupToParent.Count)

# ---- party classification -------------------------------------------------
# A ledger belongs in "party_ledgers" (vs "ledgers") when any group in its
# ancestry is a debtor / creditor / bank / cash / bank-OD / branch head.
# Verified to reproduce the reference amd_Transactions split at 99.977%.
$PARTY_ROOT_PATTERNS = @(
    'sundry debtors','sundry creditors','bank accounts',
    'cash-in-hand','cash in hand','bank od','bank occ',
    'branch / divisions','branch/divisions'
)
$groupIsPartyCache = @{}
function Test-PartyGroup([string]$grp) {
    if (-not $grp) { return $false }
    if ($groupIsPartyCache.ContainsKey($grp)) { return $groupIsPartyCache[$grp] }
    $cur = $grp; $seen = @{}; $result = $false
    while ($cur -and -not $seen.ContainsKey($cur)) {
        $seen[$cur] = $true
        $lc = $cur.ToLower()
        foreach ($p in $PARTY_ROOT_PATTERNS) { if ($lc -eq $p -or $lc.Contains($p)) { $result = $true; break } }
        if ($result) { break }
        $par = $groupToParent[$cur]
        if (-not $par -or $par -eq "Primary") { break }
        $cur = $par
    }
    $groupIsPartyCache[$grp] = $result
    return $result
}
# precompute per ledger
$isPartyLedger = @{}
foreach ($ln in $ledgerToGroup.Keys) { $isPartyLedger[$ln] = Test-PartyGroup $ledgerToGroup[$ln] }

# ---- build the Master JSON structure -------------------------------------
# groups: root heads (parent "" or "Primary") map to null, matching the dashboard hierarchy.
$mLedgers = [ordered]@{}
foreach ($ln in ($ledgerToGroup.Keys | Sort-Object)) { $mLedgers[$ln] = $ledgerToGroup[$ln] }
$mGroups = [ordered]@{}
foreach ($gn in ($groupToParent.Keys | Sort-Object)) {
    $par = $groupToParent[$gn]
    if (-not $par -or $par -eq "Primary") { $mGroups[$gn] = $null } else { $mGroups[$gn] = $par }
}
$masterObj = [ordered]@{ ledgers = $mLedgers; groups = $mGroups }

# ======================================================================
# STEP 2 - DAY BOOK  ->  transactions in dashboard shape
# ======================================================================
Write-Host "Pulling day book..."

$txnsOut  = New-Object System.Collections.ArrayList
$csvDay   = New-Object System.Collections.ArrayList   # only used if -EmitCsv
$csvLines = New-Object System.Collections.ArrayList

$start = [datetime]::ParseExact($FromDate,'yyyyMMdd',$null)
$end   = [datetime]::ParseExact($ToDate,  'yyyyMMdd',$null)

for ($d = $start; $d -le $end; $d = $d.AddDays(1)) {
    $ymd = $d.ToString('yyyyMMdd')

    $dayPayload = @"
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Day Book</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>$Company</SVCURRENTCOMPANY>
      <SVCURRENTDATE>$ymd</SVCURRENTDATE>
      <SVFROMDATE>$ymd</SVFROMDATE>
      <SVTODATE>$ymd</SVTODATE>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>
"@
    try   { $raw = Post-Tally $dayPayload }
    catch { Write-Warning ("  {0} : request failed - {1}" -f $ymd, $_.Exception.Message); continue }

    [xml]$xml = $raw
    $dayCount = 0

    foreach ($v in $xml.SelectNodes("//VOUCHER")) {
        $date = xval $v.DATE; if (-not $date) { continue }
        $dayCount++

        $vtype = xval $v.VOUCHERTYPENAME
        $vnum  = xval $v.VOUCHERNUMBER
        $party = xval $v.PARTYLEDGERNAME
        if (-not $party) { $party = xval $v.PARTYNAME }
        # Stable unique id for idempotent upsert. Prefer Tally's real internal ids
        # (GUID / MASTERID / VOUCHERKEY). Do NOT synthesize "type-no-date" -- voucher
        # numbers repeat (duplicate Purchase #s etc.), so that collides and drops
        # vouchers. If none is present, leave it empty and the loader keys on
        # date+type+no+content-hash so distinct vouchers are never merged.
        $guid  = xval $v.GUID
        if (-not $guid) { $guid = xval $v.MASTERID }
        if (-not $guid) { $guid = xval $v.VOUCHERKEY }
        if (-not $guid) { $guid = xval $v.ALTERID }

        # Collect ALL postings (top-level ledger entries + inventory accounting
        # allocations), then split into the two buckets, summing repeats.
        $postings = New-Object System.Collections.ArrayList
        Collect-Postings $v $postings
        $ledObj   = [ordered]@{}
        $partyObj = [ordered]@{}
        foreach ($p in $postings) {
            $ln = $p.Ledger; $amt = $p.Amount
            if ($isPartyLedger[$ln]) {
                if ($partyObj.Contains($ln)) { $partyObj[$ln] = [math]::Round($partyObj[$ln] + $amt, 2) }
                else { $partyObj[$ln] = $amt }
            } else {
                if ($ledObj.Contains($ln)) { $ledObj[$ln] = [math]::Round($ledObj[$ln] + $amt, 2) }
                else { $ledObj[$ln] = $amt }
            }
            if ($EmitCsv) {
                [void]$csvLines.Add([PSCustomObject][ordered]@{
                    'Date'=$date;'Voucher Type'=$vtype;'Voucher No'=$vnum;'Ledger'=$ln;
                    'Group'=$ledgerToGroup[$ln];'Amount (signed)'=$amt;
                    'Dr/Cr'= if ($amt -lt 0){"Dr"}else{"Cr"}
                })
            }
        }

        $vObj = [ordered]@{
            date          = $date       # keep yyyyMMdd - the dashboards slice this string
            party         = $party
            no            = $vnum
            type          = $vtype
            ledgers       = $ledObj
            party_ledgers = $partyObj
            guid          = $guid       # extra key for idempotent Mongo upsert; dashboards ignore it
        }
        [void]$txnsOut.Add($vObj)

        if ($EmitCsv) {
            [void]$csvDay.Add([PSCustomObject][ordered]@{
                'Date'=$date;'Vch Type'=$vtype;'Vch No.'=$vnum;'Party'=$party
            })
        }
    }

    Write-Host ("  {0} : {1} vouchers" -f $ymd, $dayCount)
    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host ("TOTAL vouchers: {0}" -f $txnsOut.Count)

# ======================================================================
# STEP 3 - WRITE JSON (dashboard-native)
# ======================================================================
# ConvertTo-Json needs a generous depth: master is 2 deep, txns are 3 deep.
# Empty {} buckets: force an object even when a voucher has no lines on a side.
function To-Json($obj, [int]$depth) {
    $j = $obj | ConvertTo-Json -Depth $depth -Compress
    return $j
}

$masterPath = Join-Path $OutDir ("{0}_Master.json"       -f $Branch)
$txnsPath   = Join-Path $OutDir ("{0}_Transactions.json" -f $Branch)

# Write master. ConvertTo-Json emits an empty ordered dict as {} correctly.
[System.IO.File]::WriteAllText($masterPath, (To-Json $masterObj 6), (New-Object System.Text.UTF8Encoding($false)))

# Transactions: build the array json. For 6k+ vouchers ConvertTo-Json is fine but
# guard the empty-bucket case (PS 5.1 renders an empty [ordered]@{} as {} - good).
[System.IO.File]::WriteAllText($txnsPath, (To-Json $txnsOut.ToArray() 6), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("Wrote {0}" -f $masterPath)
Write-Host ("Wrote {0}" -f $txnsPath)

if ($EmitCsv -and $csvDay.Count -gt 0) {
    $stamp = if ($FromDate -eq $ToDate) { $FromDate } else { "${FromDate}_to_${ToDate}" }
    $csvDay   | Export-Csv (Join-Path $OutDir "DayBook_$stamp.csv")       -NoTypeInformation -Encoding UTF8
    $csvLines | Export-Csv (Join-Path $OutDir "LedgerEntries_$stamp.csv") -NoTypeInformation -Encoding UTF8
    Write-Host "Also wrote CSVs (DayBook / LedgerEntries)."
}

# ======================================================================
# STEP 4 - OPTIONAL PUSH TO INGEST API
# ======================================================================
if ($IngestUrl) {
    Write-Host ("Pushing to {0}/ingest ..." -f $IngestUrl)
    $payload = [ordered]@{
        branch  = $Branch
        from    = $FromDate
        to      = $ToDate
        master  = $masterObj
        vouchers= $txnsOut.ToArray()
    }
    $body = $payload | ConvertTo-Json -Depth 8 -Compress
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($IngestToken) { $headers['x-ingest-token'] = $IngestToken }
    try {
        $resp = Invoke-WebRequest -Uri ("{0}/ingest" -f $IngestUrl.TrimEnd('/')) `
                -Method Post -Body $body -Headers $headers -UseBasicParsing
        Write-Host ("  Ingest OK: {0}" -f $resp.Content)
    } catch {
        Write-Warning ("  Ingest failed: {0}" -f $_.Exception.Message)
        Write-Warning ("  Files are still on disk at {0} - push later with server/loader.js" -f $OutDir)
    }
} else {
    Write-Host "No -IngestUrl given: files written locally only."
    Write-Host "Push them from an internet-connected machine with: node server/loader.js"
}
