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
    [switch]$EmitCsv,                    # also write the original 7 CSVs (off by default)
    [switch]$Incremental,                # ALTERID-based true-incremental sync (needs -IngestUrl)
    [switch]$DryRun                      # incremental: print the plan, don't pull detail or post
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
# ---- full voucher detail (for the printable invoice / journal PDF) -----------
# Tally's Day Book XML export already returns the complete voucher tree - the
# dashboards only ever consumed the ledger amounts. This block harvests the rest
# (party GSTIN/address, invoice metadata, e-way bill, narration, and the stock
# item lines with HSN/qty/rate/amount) into a "details" object so the portal can
# reprint a voucher exactly like Tally does. Every field degrades to "" / [] when
# the node is absent, so a bare journal voucher just carries empty extras.
# First non-empty of several candidate child tags (Tally spells fields several ways).
function xfirst($node, [string[]]$names) {
    foreach ($n in $names) {
        $c = $node.SelectSingleNode($n)
        if ($c) { $t = xval $c; if ($t) { return $t } }
    }
    return ""
}
# Collect the text of every child element under the first matching *.LIST wrapper
# (used for multi-line address blocks). Returns a string array.
function xaddress($node, [string[]]$listNames) {
    $lines = New-Object System.Collections.ArrayList
    foreach ($ln in $listNames) {
        foreach ($wrap in $node.SelectNodes($ln)) {
            foreach ($child in $wrap.ChildNodes) {
                if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
                    $t = xval $child
                    if ($t) { [void]$lines.Add($t) }
                }
            }
        }
        if ($lines.Count -gt 0) { break }
    }
    return $lines.ToArray()
}
# Pull the stock-item lines. Each ALLINVENTORYENTRIES.LIST is one invoice row.
function Get-InventoryItems($v) {
    $items = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($inv in $v.SelectNodes(".//ALLINVENTORYENTRIES.LIST")) {
        $name = xfirst $inv @("STOCKITEMNAME","STOCKITEM")
        $amt  = ToAmount (xfirst $inv @("AMOUNT"))
        # Skip empty wrappers (some vouchers carry a trailing blank entry).
        if (-not $name -and $amt -eq 0) { continue }
        $i++
        $hsn  = xfirst $inv @("GSTHSNNAME","HSNMASTERNAME","HSNCODE","HSN")
        $rate = xfirst $inv @("RATE")                 # e.g. "655.00/Pcs"
        $qtyRaw = xfirst $inv @("BILLEDQTY","ACTUALQTY")   # e.g. "200 Pcs" or "200.0 Kgs"
        # Split a Tally quantity like "200.0 Pcs" into number + unit (best effort).
        $qtyNum = ""; $qtyUnit = ""
        if ($qtyRaw) {
            $m = [regex]::Match($qtyRaw, "^\s*(-?[0-9.,]+)\s*(.*)$")
            if ($m.Success) { $qtyNum = $m.Groups[1].Value; $qtyUnit = $m.Groups[2].Value.Trim() } else { $qtyNum = $qtyRaw }
        }
        $disc = xfirst $inv @("DISCOUNT")
        [void]$items.Add([ordered]@{
            slNo = $i; description = $name; hsn = $hsn;
            qty = $qtyNum; unit = $qtyUnit; rate = $rate;
            disc = $disc; amount = $amt
        })
    }
    return $items.ToArray()
}
# Everything except the ledger amounts. Best-effort on the metadata tags (Tally
# names them inconsistently across versions); guaranteed on inventory + narration.
function Get-VoucherDetails($v) {
    return [ordered]@{
        narration      = xfirst $v @("NARRATION")
        reference      = xfirst $v @("REFERENCE","BASICORDERREF")
        refDate        = xfirst $v @("REFERENCEDATE")
        # party / buyer
        partyGstin     = xfirst $v @("PARTYGSTIN","CONSIGNEEGSTIN")
        partyName      = xfirst $v @("PARTYNAME","PARTYLEDGERNAME","PARTYMAILINGNAME","BASICBUYERNAME")
        partyMailName  = xfirst $v @("PARTYMAILINGNAME","BASICBUYERNAME")
        partyAddress   = xaddress $v @("BASICBUYERADDRESS.LIST","LEDGERMAILINGADDRESS.LIST")
        partyState     = xfirst $v @("PARTYSTATENAME","STATENAME","CONSIGNEESTATENAME")
        placeOfSupply  = xfirst $v @("PLACEOFSUPPLY")
        # consignee (ship-to)
        consigneeName  = xfirst $v @("CONSIGNEEMAILINGNAME","BASICBUYERNAME")
        consigneeGstin = xfirst $v @("CONSIGNEEGSTIN","PARTYGSTIN")
        consigneeAddr  = xaddress $v @("ADDRESS.LIST","CONSIGNEEADDRESS.LIST")
        consigneeState = xfirst $v @("CONSIGNEESTATENAME","STATENAME")
        # dispatch / logistics
        deliveryNote     = xfirst $v @("BASICSHIPDELIVERYNOTE","DELIVERYNOTENO","BASICSHIPDOCUMENTNO")
        deliveryNoteDate = xfirst $v @("DELIVERYNOTEDATE")
        despatchDocNo    = xfirst $v @("BASICSHIPDOCUMENTNO")
        despatchedThrough= xfirst $v @("BASICSHIPPEDBY")
        destination      = xfirst $v @("BASICFINALDESTINATION","DESTINATION")
        ewayBillNo       = xfirst $v @("EWAYBILLNUMBER","EWAYBILLNO")
        vehicleNo        = xfirst $v @("BASICSHIPVESSELNO","VEHICLENUMBER","MOTORVEHICLENO")
        termsOfPayment   = xfirst $v @("BASICDUEDATEOFPYMT","TERMSOFPAYMENT")
        termsOfDelivery  = xfirst $v @("BASICORDERTERMS","TERMSOFDELIVERY")
        buyersOrderNo    = xfirst $v @("BASICPURCHASEORDERNO","BASICORDERREF")
        buyersOrderDate  = xfirst $v @("BASICORDERDATE")
        # e-invoice
        irn      = xfirst $v @("IRN","IRNNUM")
        ackNo    = xfirst $v @("ACKNO","IRNACKNO")
        ackDate  = xfirst $v @("ACKDATE","IRNACKDATE")
        # line items
        items    = Get-InventoryItems $v
    }
}
# Turn one XML <VOUCHER> node into the dashboard-shaped object (reads $isPartyLedger
# at call time). Returns $null for a dateless node.
function ConvertTo-VoucherObject($v) {
    $date = xval $v.DATE; if (-not $date) { return $null }
    $vtype = xval $v.VOUCHERTYPENAME
    $vnum  = xval $v.VOUCHERNUMBER
    $party = xval $v.PARTYLEDGERNAME
    if (-not $party) { $party = xval $v.PARTYNAME }
    $guid  = xval $v.GUID
    if (-not $guid) { $guid = xval $v.MASTERID }
    if (-not $guid) { $guid = xval $v.VOUCHERKEY }
    if (-not $guid) { $guid = xval $v.ALTERID }
    $postings = New-Object System.Collections.ArrayList
    Collect-Postings $v $postings
    $ledObj = [ordered]@{}; $partyObj = [ordered]@{}
    foreach ($p in $postings) {
        $ln = $p.Ledger; $amt = $p.Amount
        if ($isPartyLedger[$ln]) {
            if ($partyObj.Contains($ln)) { $partyObj[$ln] = [math]::Round($partyObj[$ln] + $amt, 2) } else { $partyObj[$ln] = $amt }
        } else {
            if ($ledObj.Contains($ln)) { $ledObj[$ln] = [math]::Round($ledObj[$ln] + $amt, 2) } else { $ledObj[$ln] = $amt }
        }
    }
    $details = Get-VoucherDetails $v
    return [ordered]@{ date=$date; party=$party; no=$vnum; type=$vtype; ledgers=$ledObj; party_ledgers=$partyObj; details=$details; guid=$guid }
}
# Pull one day's Day Book, return an ArrayList of voucher objects.
function Get-DayVouchers([string]$ymd) {
    $payload = @"
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
    $out = New-Object System.Collections.ArrayList
    try { $raw = Post-Tally $payload } catch { Write-Warning ("  {0} : request failed - {1}" -f $ymd, $_.Exception.Message); return $out }
    [xml]$xml = $raw
    foreach ($v in $xml.SelectNodes("//VOUCHER")) { $o = ConvertTo-VoucherObject $v; if ($o) { [void]$out.Add($o) } }
    return $out
}
# Lightweight metadata scan: every voucher's guid + date + alterId over a range.
# One request, a few fields - the basis for ALTERID incremental sync.
function Get-VoucherMeta([string]$fromYmd, [string]$toYmd) {
    $payload = @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VchMeta</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>$Company</SVCURRENTCOMPANY>
      <SVFROMDATE>$fromYmd</SVFROMDATE>
      <SVTODATE>$toYmd</SVTODATE>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="VchMeta" ISMODIFY="No">
        <TYPE>Voucher</TYPE>
        <FETCH>GUID, MASTERID, DATE, ALTERID</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
    $out = New-Object System.Collections.ArrayList
    [xml]$xml = Post-Tally $payload
    foreach ($v in $xml.SelectNodes("//VOUCHER")) {
        $g = xval $v.GUID; if (-not $g) { $g = xval $v.MASTERID }
        $dt = xval $v.DATE
        if ($dt -and $dt.Length -ne 8) { try { $dt = ([datetime]$dt).ToString('yyyyMMdd') } catch {} }
        $al = 0; [int]::TryParse((xval $v.ALTERID), [ref]$al) | Out-Null
        if ($g -and $dt) { [void]$out.Add([PSCustomObject]@{ guid=$g; date=$dt; alterId=$al }) }
    }
    return $out
}
# Full incremental cycle: ask the API how far we've synced, scan metadata, pull
# only changed dates in full, post back (replace-by-date + deletion reconcile).
function Invoke-Incremental {
    if (-not $IngestUrl) { throw "Incremental needs -IngestUrl. Offline: use a full pull + loader.js --reset." }
    $base = $IngestUrl.TrimEnd('/')
    $lastAlter = 0
    try {
        $st = Invoke-WebRequest -Uri ("{0}/api/sync-state?branch={1}" -f $base, $Branch) -UseBasicParsing
        $lastAlter = [int]((($st.Content) | ConvertFrom-Json).lastAlterId)
    } catch { Write-Warning ("  sync-state fetch failed, assuming 0: {0}" -f $_.Exception.Message) }
    Write-Host ("Incremental sync (branch {0}) - lastAlterId={1}" -f $Branch, $lastAlter)

    $meta = Get-VoucherMeta $FromDate $ToDate
    Write-Host ("  metadata scan: {0} vouchers" -f $meta.Count)
    $changed = @{}; $currentGuids = New-Object System.Collections.ArrayList; $maxAlter = $lastAlter
    $scanFrom = $null; $scanTo = $null
    foreach ($m in $meta) {
        [void]$currentGuids.Add($m.guid)
        if ($m.alterId -gt $maxAlter) { $maxAlter = $m.alterId }
        if ($m.alterId -gt $lastAlter) { $changed[$m.date] = $true }
        if ($null -eq $scanFrom -or $m.date -lt $scanFrom) { $scanFrom = $m.date }
        if ($null -eq $scanTo   -or $m.date -gt $scanTo)   { $scanTo   = $m.date }
    }
    $changedDates = @($changed.Keys | Sort-Object)
    Write-Host ("  changed dates: {0}  newMaxAlterId: {1}" -f $changedDates.Count, $maxAlter)
    if ($DryRun) { Write-Host ("  [DryRun] would re-pull: {0}" -f ($changedDates -join ', ')); return }

    $vouchers = New-Object System.Collections.ArrayList
    foreach ($cd in $changedDates) {
        $dv = Get-DayVouchers $cd
        foreach ($o in $dv) { [void]$vouchers.Add($o) }
        Write-Host ("    {0}: {1} vouchers" -f $cd, $dv.Count)
        Start-Sleep -Milliseconds 150
    }
    $payload = [ordered]@{
        branch       = $Branch
        lastAlterId  = $maxAlter
        changedDates = $changedDates
        vouchers     = $vouchers.ToArray()
        master       = $masterObj
        currentGuids = $currentGuids.ToArray()
        scanFrom     = $scanFrom
        scanTo       = $scanTo
        reconcile    = $true
    }
    $body = $payload | ConvertTo-Json -Depth 12 -Compress
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($IngestToken) { $headers['x-ingest-token'] = $IngestToken }
    $resp = Invoke-WebRequest -Uri ("{0}/sync" -f $base) -Method Post -Body $body -Headers $headers -UseBasicParsing
    Write-Host ("  sync posted: {0}" -f $resp.Content)
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
# INCREMENTAL MODE - short-circuits the full pull below.
# ======================================================================
if ($Incremental) {
    Invoke-Incremental
    Write-Host "Incremental run complete."
    return
}

# ======================================================================
# STEP 2 - DAY BOOK  ->  transactions in dashboard shape (full range)
# ======================================================================
Write-Host "Pulling day book..."

$txnsOut  = New-Object System.Collections.ArrayList
$csvDay   = New-Object System.Collections.ArrayList   # only used if -EmitCsv

$start = [datetime]::ParseExact($FromDate,'yyyyMMdd',$null)
$end   = [datetime]::ParseExact($ToDate,  'yyyyMMdd',$null)

for ($d = $start; $d -le $end; $d = $d.AddDays(1)) {
    $ymd = $d.ToString('yyyyMMdd')
    $dayV = Get-DayVouchers $ymd
    foreach ($o in $dayV) {
        [void]$txnsOut.Add($o)
        if ($EmitCsv) { [void]$csvDay.Add([PSCustomObject][ordered]@{ 'Date'=$o.date;'Vch Type'=$o.type;'Vch No.'=$o.no;'Party'=$o.party }) }
    }
    Write-Host ("  {0} : {1} vouchers" -f $ymd, $dayV.Count)
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
# Depth 10: voucher -> details -> items[] -> item{} -> value needs the extra levels.
[System.IO.File]::WriteAllText($txnsPath, (To-Json $txnsOut.ToArray() 10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("Wrote {0}" -f $masterPath)
Write-Host ("Wrote {0}" -f $txnsPath)

if ($EmitCsv -and $csvDay.Count -gt 0) {
    $stamp = if ($FromDate -eq $ToDate) { $FromDate } else { "${FromDate}_to_${ToDate}" }
    $csvDay | Export-Csv (Join-Path $OutDir "DayBook_$stamp.csv") -NoTypeInformation -Encoding UTF8
    Write-Host "Also wrote DayBook CSV."
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
    $body = $payload | ConvertTo-Json -Depth 12 -Compress
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
