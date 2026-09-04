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

    RUN (which companies/years does this Tally hold?):
        powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -ListCompanies

    RUN (back-fill ONE old financial year - note -Historical):
        powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 `
                   -Historical -FromDate 20150401 -ToDate 20160331 -Branch kol `
                   -Company "CDC PRINTERS 2015-16" `
                   -IngestUrl "https://your-api.onrender.com" -IngestToken "SECRET"
        (for every year in one go, use run_backfill.ps1 instead)

    RUN (the wrong company went into a branch - wipe it and re-ingest clean):
        powershell -ExecutionPolicy Bypass -File .\TallyToJson.ps1 -Reset `
                   -FromDate 20250401 -ToDate 20260820 -Branch kol `
                   -Company "CDC PRINTERS 2025-26" `
                   -IngestUrl "https://your-api.onrender.com" -IngestToken "SECRET" -ChunkSize 1000
        A plain re-push does NOT undo it: the other company's vouchers carry their own
        GUIDs, so nothing overwrites them and the branch keeps BOTH companies. -Reset
        clears -FromDate..-ToDate for that branch (plus its master and sync mark) once
        the Tally pull has succeeded, then pushes. -ResetAll clears every date instead.
        Do the same for the other branch, then check /api/meta.

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
    [switch]$Historical,                 # pulling an OLD financial-year company: merge its master
                                         #   instead of replacing the live one (see run_backfill.ps1)
    [switch]$ListCompanies,              # print the companies this Tally knows about, then exit
    [switch]$Reset,                      # wipe this branch over -FromDate..-ToDate in MongoDB before
                                         #   pushing. Use after the WRONG company was pulled into a
                                         #   branch: those vouchers carry the other company's GUIDs,
                                         #   so a plain re-push leaves BOTH companies in the branch.
    [switch]$ResetAll,                   # same, but wipes every voucher of the branch, not just the
                                         #   date range (also drops any back-filled years).
    [switch]$AllowBranchMismatch,        # skip the -Branch vs -Company city check below
    [switch]$DryRun,                     # incremental: print the plan, don't pull detail or post
    [int]$ChunkSize  = 2000,             # vouchers per /ingest POST. A full-year pull is far too big
                                         #   for one body (413); lower this if you still see 413.
    [int]$MinLedgers = 50,               # safety floor: abort if the company returns fewer ledgers
    [string]$VoucherNos = ""             #   (means it isn't loaded in this Tally). Set 0 to disable.
)                                        # targeted: only re-sync these exact voucher no(s), comma-
                                         # separated (e.g. "PUR/1337/26-27,PUR/2269/26-27"). Finds
                                         # each one's date, re-pulls just those, upserts via -IngestUrl.

$ErrorActionPreference = "Stop"

if ($ChunkSize -lt 1) { throw "-ChunkSize must be at least 1." }

# ---- guard: a reset needs somewhere to push and a full pull to refill with ----
# -Incremental posts only what changed since the last ALTERID, which after a wipe
# is not enough to rebuild the branch. Clear it with a full-range run instead.
if (($Reset -or $ResetAll) -and -not $IngestUrl) {
    throw "-Reset needs -IngestUrl: it clears the branch in MongoDB, which only the API can do."
}
if (($Reset -or $ResetAll) -and $Incremental) {
    throw "-Reset cannot be combined with -Incremental. Re-run the full range without -Incremental."
}
if (($Reset -or $ResetAll) -and $VoucherNos) {
    throw "-Reset cannot be combined with -VoucherNos: that pulls a few vouchers, not the whole range."
}

# ---- guard: -Branch must match the company being pulled --------------------
# A -Branch/-Company mismatch is silent and expensive. The other company's
# vouchers carry their own Tally GUIDs, so they do not replace anything -- they
# ADD to the branch, and every dashboard figure becomes the sum of two companies
# until someone deletes them again (-Reset). The company name is the only clue
# available before the pull, so use it: a name that says which city it is must
# agree with -Branch. A name that says nothing (the Kolkata company is just
# "CDC PRINTERS 2025-26") is left alone. -AllowBranchMismatch overrides.
if (-not $AllowBranchMismatch) {
    $coLower = $Company.ToLower()
    if ($coLower.Contains('ahmedabad') -and $Branch -ne 'ahm') {
        throw ("-Company '{0}' is the Ahmedabad company but -Branch is '{1}'. That would pour Ahmedabad's vouchers into the '{1}' branch, on top of what is already there, and only -Reset could undo it. Use -Branch ahm (or -AllowBranchMismatch if the name is misleading)." -f $Company, $Branch)
    }
    if (($coLower.Contains('kolkata') -or $coLower.Contains('calcutta')) -and $Branch -ne 'kol') {
        throw ("-Company '{0}' is the Kolkata company but -Branch is '{1}'. That would pour Kolkata's vouchers into the '{1}' branch, on top of what is already there, and only -Reset could undo it. Use -Branch kol (or -AllowBranchMismatch if the name is misleading)." -f $Company, $Branch)
    }
}

# ---- guard: historical pulls must never drive the incremental machinery ----
# ALTERID is a per-COMPANY counter and sync_state stores one high-water mark per
# BRANCH. Running -Incremental against an old financial-year company would write
# that company's alterIds into the branch's high-water mark, and the next live
# sync would then skip every real change below it. A back-fill is always a full
# pull that upserts by GUID.
if ($Historical -and $Incremental) {
    throw "-Historical cannot be combined with -Incremental: an old company's ALTERID counter would corrupt the branch's sync high-water mark. Use a full pull (-Historical -FromDate ... -ToDate ...)."
}

# Windows PowerShell 5.1 defaults to TLS 1.0/1.1, but modern hosts (Render, Atlas
# API, etc.) require TLS 1.2+. Without this, HTTPS calls fail with "Could not
# create SSL/TLS secure channel" -- which makes the sync-state fetch fall back to
# lastAlterId=0 (re-pulling EVERY date) and the final /sync POST silently fail.
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ([Enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
    }
} catch { Write-Warning ("Could not raise TLS to 1.2: {0}" -f $_.Exception.Message) }

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
    # TallyPrime's HTTP gateway only answers while Tally is idle at the "Gateway of
    # Tally" screen; a momentarily-open menu/dialog makes the request fail. Retry a
    # few times so a brief blip doesn't abort the whole run.
    $r = $null; $attempt = 0; $max = 5
    while ($true) {
        $attempt++
        try {
            $r = Invoke-WebRequest -Uri $TallyUrl -Method Post -Body $body `
                 -ContentType "text/xml;charset=utf-8" -UseBasicParsing -TimeoutSec 180
            break
        } catch {
            if ($attempt -ge $max) { throw }
            $wait = 2 * $attempt
            Write-Warning ("  Tally request failed (attempt {0}/{1}) - retrying in {2}s. Is Tally idle at 'Gateway of Tally'? [{3}]" -f $attempt, $max, $wait, $_.Exception.Message)
            Start-Sleep -Seconds $wait
        }
    }
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
# Recursively gather every bill-wise allocation attached to a ledger posting.
# Tally nests these as *LEDGERENTRIES.LIST > BILLALLOCATIONS.LIST, one per bill the
# posting touches. Each carries the bill reference NAME (e.g. "CDC/7037/25-26"), the
# BILLTYPE ("New Ref" = a new bill the invoice creates, "Agst Ref" = settles an
# existing bill, "Advance"/"On Account" = unlinked), and the signed AMOUNT applied to
# that bill. Capturing these lets the dashboard settle a receipt against the exact
# bill it was posted against, instead of guessing oldest-first (date FIFO).
function Collect-BillAllocs($node, $list) {
    foreach ($c in $node.ChildNodes) {
        if ($c.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
        $nm = $c.Name
        if ($nm -like "*LEDGERENTRIES.LIST") {
            $ln = xval $c.LEDGERNAME
            if ($ln) {
                foreach ($ba in $c.SelectNodes("BILLALLOCATIONS.LIST")) {
                    # $ba.NAME must NOT be used here. When Tally emits an allocation
                    # element with no <NAME> child -- a receipt posted on account, say
                    # -- PowerShell falls back to XmlNode's own Name property and hands
                    # back the tag name, so the guard below never fires and the bill
                    # reference is recorded as the literal "BILLALLOCATIONS.LIST" with
                    # a zero amount. Ask for the child element by path instead.
                    $bn = xval $ba.SelectSingleNode("NAME")
                    if (-not $bn) { continue }
                    [void]$list.Add([PSCustomObject]@{
                        ledger = $ln
                        ref    = $bn
                        type   = xval $ba.BILLTYPE
                        amount = ToAmount (xval $ba.AMOUNT)   # raw Tally sign: -ve = Dr, +ve = Cr
                    })
                }
                continue   # leaf posting - its bills are captured; don't descend further
            }
        }
        if ($c.HasChildNodes) { Collect-BillAllocs $c $list }
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
# Tries a DIRECT child first (fast + unambiguous), then falls back to a DESCENDANT
# anywhere in the voucher subtree. Many header fields (e-way bill, buyer's order,
# delivery note) live nested inside *.LIST wrappers, so a direct-child-only lookup
# silently returned "" for them -- that's why they were blank on the printed invoice.
function xfirst($node, [string[]]$names) {
    foreach ($n in $names) {
        $c = $node.SelectSingleNode($n)
        if ($c) { $t = xval $c; if ($t) { return $t } }
    }
    foreach ($n in $names) {
        $c = $node.SelectSingleNode(".//$n")
        if ($c) { $t = xval $c; if ($t) { return $t } }
    }
    return ""
}
# Every non-empty descendant value across the candidate tags, in document order.
# Duplicates are KEPT (two order rows can share a date -> "13 Jul 26, 13 Jul 26").
function xall($node, [string[]]$names) {
    $vals = New-Object System.Collections.ArrayList
    foreach ($n in $names) {
        foreach ($c in $node.SelectNodes(".//$n")) {
            $t = xval $c
            if ($t) { [void]$vals.Add($t) }
        }
    }
    return $vals.ToArray()
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
        # Build the full description block exactly like the Tally invoice prints it:
        # stock item name, then any user description line(s), then the batch name.
        # (These live nested under the inventory entry, hence xall's descendant scan.)
        $descLines = New-Object System.Collections.ArrayList
        if ($name) { [void]$descLines.Add($name) }
        foreach ($u in (xall $inv @("BASICUSERDESCRIPTION","USERDESCRIPTION"))) { [void]$descLines.Add($u) }
        $batch = xfirst $inv @("BATCHNAME")
        if ($batch) { [void]$descLines.Add("Batch : " + $batch) }
        $desc = ($descLines -join "`n")
        [void]$items.Add([ordered]@{
            slNo = $i; description = $desc; hsn = $hsn;
            qty = $qtyNum; unit = $qtyUnit; rate = $rate;
            disc = $disc; amount = $amt
        })
    }
    return $items.ToArray()
}
# Buyer's order details are one row per referenced order, each in its own wrapper
# (a sale can settle several quotations/orders). Pull them PAIRED so order No. N
# lines up with order Date N, then join with ", " for the invoice's two columns.
function Get-BuyerOrders($v) {
    $nos = New-Object System.Collections.ArrayList
    $dts = New-Object System.Collections.ArrayList
    foreach ($wrap in @("INVOICEORDERLIST.LIST","BASICORDERDATES.LIST")) {
        foreach ($ord in $v.SelectNodes(".//$wrap")) {
            $on = xfirst $ord @("BASICPURCHASEORDERNO","BASICORDERREF")
            $od = xfirst $ord @("BASICORDERDATE")
            if ($on -or $od) { [void]$nos.Add($on); [void]$dts.Add($od) }
        }
        if ($nos.Count -gt 0) { break }
    }
    return @{ no = ($nos -join ", "); date = ($dts -join ", ") }
}
# Everything except the ledger amounts. Best-effort on the metadata tags (Tally
# names them inconsistently across versions); guaranteed on inventory + narration.
function Get-VoucherDetails($v) {
    $orders = Get-BuyerOrders $v
    # Dispatch/logistics fields sit in their own nested wrappers -- scope the lookup
    # to the wrapper so a generic tag name (e.g. BILLNUMBER) can't match elsewhere.
    #   e-way bill  : <EWAYBILLDETAILS.LIST><BILLNUMBER>..</><BILLDATE>..</></>
    #   delivery note: <INVOICEDELNOTES.LIST><BASICSHIPDELIVERYNOTE>..</><BASICSHIPPINGDATE>..</></>
    $eway    = $v.SelectSingleNode(".//EWAYBILLDETAILS.LIST")
    $ewayNo  = if ($eway) { xfirst $eway @("BILLNUMBER","EWAYBILLNUMBER","EWAYBILLNO") } else { "" }
    $deln    = $v.SelectSingleNode(".//INVOICEDELNOTES.LIST")
    $delNote = if ($deln) { xfirst $deln @("BASICSHIPDELIVERYNOTE","DELIVERYNOTENO") } else { "" }
    $delDate = if ($deln) { xfirst $deln @("BASICSHIPPINGDATE","BASICSHIPDELIVERYNOTEDATE") } else { "" }
    # Party (supplier on a purchase / customer on a sale) mailing address = ADDRESS.LIST,
    # with the party's pincode (a separate PARTYPINCODE tag) appended as a line.
    $partyAddr = @(xaddress $v @("ADDRESS.LIST","LEDGERMAILINGADDRESS.LIST","BASICBUYERADDRESS.LIST"))
    $partyPin  = xfirst $v @("PARTYPINCODE")
    if ($partyPin -and (($partyAddr -join " ") -notmatch "Pincode")) { $partyAddr = @($partyAddr) + ("Pincode : " + $partyPin) }
    return [ordered]@{
        narration      = xfirst $v @("NARRATION")
        reference      = xfirst $v @("REFERENCE","BASICORDERREF")
        refDate        = xfirst $v @("REFERENCEDATE")
        # party / buyer  (contact person/email/mobile are NOT on the voucher -- they
        # come from the party's Ledger master and are merged in by the API.)
        partyGstin     = xfirst $v @("PARTYGSTIN","CONSIGNEEGSTIN")
        partyName      = xfirst $v @("PARTYNAME","PARTYLEDGERNAME","PARTYMAILINGNAME","BASICBUYERNAME")
        partyMailName  = xfirst $v @("PARTYMAILINGNAME","BASICBUYERNAME")
        # The party's OWN mailing address is ADDRESS.LIST (+ PARTYPINCODE). On a sale
        # that equals the buyer address; on a PURCHASE it's the supplier's (whereas
        # BASICBUYERADDRESS is CDC-the-buyer's) -- so ADDRESS.LIST must come first or the
        # supplier block gets CDC's address. See $partyAddr built above.
        partyAddress   = $partyAddr
        partyState     = xfirst $v @("PARTYSTATENAME","STATENAME","CONSIGNEESTATENAME")
        placeOfSupply  = xfirst $v @("PLACEOFSUPPLY")
        # consignee (ship-to)
        consigneeName  = xfirst $v @("CONSIGNEEMAILINGNAME","BASICBUYERNAME")
        consigneeGstin = xfirst $v @("CONSIGNEEGSTIN","PARTYGSTIN")
        consigneeAddr  = xaddress $v @("ADDRESS.LIST","CONSIGNEEADDRESS.LIST")
        consigneeState = xfirst $v @("CONSIGNEESTATENAME","STATENAME")
        # dispatch / logistics
        deliveryNote     = $delNote
        deliveryNoteDate = $delDate
        despatchDocNo    = xfirst $v @("BASICSHIPDOCUMENTNO")
        despatchedThrough= xfirst $v @("BASICSHIPPEDBY")
        destination      = xfirst $v @("BASICFINALDESTINATION","DESTINATION")
        billOfLading     = xfirst $v @("BILLOFLADINGNO")
        billOfLadingDate = xfirst $v @("BILLOFLADINGDATE")
        ewayBillNo       = $ewayNo
        vehicleNo        = xfirst $v @("BASICSHIPVESSELNO","VEHICLENUMBER","MOTORVEHICLENO")
        termsOfPayment   = xfirst $v @("BASICDUEDATEOFPYMT","TERMSOFPAYMENT")
        termsOfDelivery  = xfirst $v @("BASICORDERTERMS","TERMSOFDELIVERY")
        buyersOrderNo    = $orders.no
        buyersOrderDate  = $orders.date
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
    $billAllocs = New-Object System.Collections.ArrayList
    Collect-BillAllocs $v $billAllocs
    $out = [ordered]@{ date=$date; party=$party; no=$vnum; type=$vtype; ledgers=$ledObj; party_ledgers=$partyObj; details=$details; guid=$guid }
    if ($billAllocs.Count -gt 0) { $out.bills = $billAllocs.ToArray() }
    return $out
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

# ---- TARGETED re-sync of specific voucher numbers -------------------------
# Server-side Collection filter finds a voucher's DATE by its exact number, so we
# can re-pull just that one day's full detail and upsert only the wanted vouchers.
function Find-VoucherDate([string]$vno) {
    # CONTAINS (not '=') is far more tolerant of how Tally stores the number, then we
    # confirm the exact match in PS (xval trims, so trailing-space numbers still match).
    $q = @"
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VFind</ID></HEADER>
<BODY><DESC><STATICVARIABLES>
<SVCURRENTCOMPANY>$Company</SVCURRENTCOMPANY>
<SVFROMDATE>20250401</SVFROMDATE><SVTODATE>20270331</SVTODATE>
<SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="VFind" ISMODIFY="No"><TYPE>Voucher</TYPE><FILTER>fNo</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="fNo">`$VoucherNumber CONTAINS "$vno"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>
"@
    [xml]$xml = Post-Tally $q
    $fallback = ""
    foreach ($n in $xml.SelectNodes("//VOUCHER")) {
        $dt = xval $n.DATE
        if ($dt -and $dt.Length -ne 8) { try { $dt = ([datetime]$dt).ToString('yyyyMMdd') } catch {} }
        if (-not $dt) { continue }
        if ((xval $n.VOUCHERNUMBER) -eq $vno) { return $dt }   # exact
        if (-not $fallback) { $fallback = $dt }                 # first CONTAINS hit
    }
    return $fallback
}
function Invoke-Targeted {
    $nos = @($VoucherNos -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Write-Host ("Targeted re-sync (branch {0}): {1}" -f $Branch, ($nos -join ', '))
    $want = @{}; foreach ($n in $nos) { $want[$n] = $true }
    $days = @{}
    foreach ($vno in $nos) {
        $d = Find-VoucherDate $vno
        if ($d) { $days[$d] = $true; Write-Host ("  {0} -> {1}" -f $vno, $d) }
        else    { Write-Warning ("  {0}: not found in {1}" -f $vno, $Company) }
    }
    $out = New-Object System.Collections.ArrayList
    foreach ($ymd in ($days.Keys | Sort-Object)) {
        foreach ($o in (Get-DayVouchers $ymd)) {
            if ($want[$o.no]) {
                $ni = 0; if ($o.details -and $o.details.items) { $ni = @($o.details.items).Count }
                $nl = 0; if ($o.ledgers) { $nl = @($o.ledgers.Keys).Count }
                Write-Host ("    + {0}  (type='{1}', items={2}, ledgers={3})" -f $o.no, $o.type, $ni, $nl)
                [void]$out.Add($o)
            }
        }
    }
    Write-Host ("  collected {0} voucher(s)" -f $out.Count)
    if ($out.Count -eq 0) { Write-Warning "nothing matched - check the exact voucher numbers/company."; return }
    if (-not $IngestUrl) {
        $p = Join-Path $OutDir ("{0}_TargetVouchers.json" -f $Branch)
        [System.IO.File]::WriteAllText($p, ($out.ToArray() | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host ("  no -IngestUrl: wrote {0} (push it yourself)." -f $p); return
    }
    # Upsert ONLY these vouchers (+ master, so the contact block enriches).
    $payload = [ordered]@{ branch = $Branch; master = $masterObj; vouchers = $out.ToArray() }
    $body = $payload | ConvertTo-Json -Depth 12 -Compress
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($IngestToken) { $headers['x-ingest-token'] = $IngestToken }
    $resp = Invoke-WebRequest -Uri ("{0}/ingest" -f $IngestUrl.TrimEnd('/')) -Method Post -Body $body -Headers $headers -UseBasicParsing
    Write-Host ("  ingest OK: {0}" -f $resp.Content)
}

# ======================================================================
# COMPANY DISCOVERY - which years does this Tally actually hold?
# ======================================================================
# A multi-year back-fill needs the EXACT company name for each financial year
# (CDC keeps one company per FY). Guessing them is how a back-fill silently pulls
# nothing, so ask Tally. Run this first, then feed the names to run_backfill.ps1.
# A COMPANY node carries NAME as BOTH an attribute and a child element, so the
# convenient $node.NAME returns the pair and stringifies to "<value> NAME".
# Read each field explicitly instead: attribute first, then child element.
function CompField($node, [string]$field) {
    $a = $node.GetAttribute($field)
    if ($a) { return ($a -replace "[\x00-\x1f]","").Trim() }
    $e = $node.SelectSingleNode($field)
    if ($e) { return xval $e }
    return ""
}
# Which companies is the Tally at -TallyUrl actually serving right now? Asked by
# -ListCompanies, and again when a pull comes back empty -- on a shared or RDP
# machine the port can belong to a DIFFERENT Tally instance (another user's
# session), and then "company not loaded" is true but points at the wrong thing.
# Naming the companies that Tally DOES have open makes that obvious immediately.
function Get-OpenCompanyRows {
    $companyPayload = @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>CompanyList</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="CompanyList" ISMODIFY="No">
        <TYPE>Company</TYPE>
        <FETCH>NAME,STARTINGFROM,ENDINGAT,BOOKSFROM</FETCH>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
    $rawXml = Post-Tally $companyPayload
    $script:CompaniesRawPath = Join-Path $OutDir "companies_raw.xml"
    [System.IO.File]::WriteAllText($script:CompaniesRawPath, $rawXml, (New-Object System.Text.UTF8Encoding($false)))
    [xml]$cx = $rawXml
    $rows = @(); $seen = @{}
    foreach ($c in $cx.SelectNodes("//COMPANY")) {
        $nm = CompField $c "NAME"
        # Skip the collection's own echo node and any duplicate.
        if (-not $nm -or $nm -eq "COMPANY" -or $seen.ContainsKey($nm)) { continue }
        $seen[$nm] = $true
        $rows += [PSCustomObject]@{
            Company = $nm
            From    = CompField $c "STARTINGFROM"
            Books   = CompField $c "BOOKSFROM"
            To      = CompField $c "ENDINGAT"
        }
    }
    # Comma so a single company still comes back as an array, not a bare object.
    return ,$rows
}

if ($ListCompanies) {
    $rows = Get-OpenCompanyRows
    $rawPath = $script:CompaniesRawPath
    if ($rows.Count -eq 0) {
        Write-Warning ("Tally returned no companies. Raw reply saved to {0} for inspection." -f $rawPath)
    } else {
        Write-Host ("Companies OPEN in Tally at {0}:" -f $TallyUrl)
        $rows | Sort-Object Company | Format-Table -AutoSize | Out-String | Write-Host
    }
    Write-Host "NOTE: this lists only the companies currently OPEN in Tally, not every company on disk."
    Write-Host "      A year missing here cannot be pulled - open it first (Alt+F3 > Select Company), then re-run."
    Write-Host "      If a company IS open on your screen but missing above, this port belongs to a DIFFERENT"
    Write-Host "      Tally (on a shared/RDP box, whichever instance grabbed it first - possibly another user's)."
    Write-Host "      Check: netstat -ano | findstr :9001   then   tasklist /FI ""PID eq <pid>"" /V"
    Write-Host ("      Raw reply: {0}" -f $rawPath)
    Write-Host ""
    Write-Host "Feed the ones you want into run_backfill.ps1 -Companies 'FY=Exact Company Name', e.g."
    Write-Host "  -Companies '2023-24=CDC PRINTERS 2023-24','2024-25=CDC PRINTERS 2024-25'"
    return
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
        <FETCH>NAME,PARENT,GUID,LEDGERCONTACT,LEDGERMOBILE,LEDGERPHONE,EMAIL,PARTYGSTIN,GSTREGISTRATIONTYPE</FETCH>
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
$ledgerContacts = @{}  # ledger name -> @{ name; email; mobile }  (party contact block)
$ledgerIds = @{}       # ledger name -> stable Tally GUID (survives renames)

[xml]$lx = Post-Tally $ledgerPayload
foreach ($l in $lx.SelectNodes("//LEDGER")) {
    $name = xval $l.NAME; if (-not $name) { continue }
    $ledgerToGroup[$name] = xval $l.PARENT
    # Stable ledger identity: GUID (falls back to MASTERID). Lets the dashboard merge
    # a party across a name change (Tally keeps the GUID when a ledger is renamed).
    $lguid = xval $l.GUID; if (-not $lguid) { $lguid = xval $l.MASTERID }
    if ($lguid) { $ledgerIds[$name] = $lguid }
    # Contact person / email / mobile live on the Ledger master, not on the voucher,
    # so the printable invoice's Bill-to contact block is sourced from here.
    $cName   = xval $l.LEDGERCONTACT
    $cEmail  = xval $l.EMAIL
    $cMobile = xval $l.LEDGERMOBILE; if (-not $cMobile) { $cMobile = xval $l.LEDGERPHONE }
    # GSTIN identifies the party far better than its name ever will, and it is the
    # one signal that survives a rename. Vouchers carry it too, but only for parties
    # that actually invoiced in the pulled range - taking it from the master covers
    # the rest (see server/aliasSuggest.js).
    $cGstin  = xval $l.PARTYGSTIN
    if ($cName -or $cEmail -or $cMobile -or $cGstin) {
        $ledgerContacts[$name] = [ordered]@{ name = $cName; email = $cEmail; mobile = $cMobile; gstin = $cGstin }
    }
}
Write-Host ("  Ledgers : {0}  (contacts: {1})" -f $ledgerToGroup.Count, $ledgerContacts.Count)

[xml]$gx = Post-Tally $groupPayload
foreach ($g in $gx.SelectNodes("//GROUP")) {
    $name = xval $g.NAME; if (-not $name) { continue }
    $groupToParent[$name] = xval $g.PARENT
}
Write-Host ("  Groups  : {0}" -f $groupToParent.Count)

# ---- SAFETY: refuse to run if the company isn't really loaded -------------
# A live CDC company has thousands of ledgers. If Tally returns only a handful,
# the requested company is almost certainly NOT loaded in THIS Tally (wrong box,
# wrong company name, or company closed). Continuing would push a near-empty
# master and overwrite the good hierarchy in Mongo, breaking that branch's
# dashboard. Abort loudly instead. Override with -MinLedgers 0 if you really do
# have a tiny company.
if ($ledgerToGroup.Count -lt $MinLedgers) {
    Write-Warning ("Company '{0}' returned only {1} ledgers (< {2}). It is almost certainly NOT loaded in the Tally at {3} -- refusing to sync branch '{4}' so the good master/vouchers in Mongo are not overwritten with empty data. Load the correct company (or fix -Company / -Branch), or pass -MinLedgers 0 to override." -f $Company, $ledgerToGroup.Count, $MinLedgers, $TallyUrl, $Branch)
    # Name the companies that Tally DOES have open. If the one you asked for is
    # missing while it is plainly open on your screen, you are talking to someone
    # else's Tally: on a shared/RDP box the port belongs to whichever instance
    # grabbed it first, which can be another user's session entirely.
    try {
        $openRows = Get-OpenCompanyRows
        if ($openRows.Count -gt 0) {
            Write-Warning ("The Tally at {0} currently has these companies OPEN:" -f $TallyUrl)
            foreach ($r in $openRows) { Write-Warning ("    - {0}" -f $r.Company) }
            Write-Warning 'If the company you asked for is open on YOUR screen but is not in that list, that'
            Write-Warning 'is a different Tally instance. Find out whose it is with:'
            Write-Warning '    netstat -ano | findstr :<port>'
            Write-Warning '    tasklist /FI "PID eq <the pid it printed>" /V'
            Write-Warning 'then give your own Tally its own port (F1 > Settings > Connectivity) and pass'
            Write-Warning '-TallyUrl http://localhost:<your port> to this script and to run_daily/run_backfill.'
        } else {
            Write-Warning ("The Tally at {0} reports no open companies at all." -f $TallyUrl)
        }
    } catch {
        Write-Warning ("  (could not list that Tally's open companies: {0})" -f $_.Exception.Message)
    }
    exit 2
}

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
$mContacts = [ordered]@{}
foreach ($ln in ($ledgerContacts.Keys | Sort-Object)) { $mContacts[$ln] = $ledgerContacts[$ln] }
$mIds = [ordered]@{}
foreach ($ln in ($ledgerIds.Keys | Sort-Object)) { $mIds[$ln] = $ledgerIds[$ln] }
$masterObj = [ordered]@{ ledgers = $mLedgers; groups = $mGroups; contacts = $mContacts; ids = $mIds }

# ======================================================================
# INCREMENTAL MODE - short-circuits the full pull below.
# ======================================================================
if ($Incremental) {
    Invoke-Incremental
    Write-Host "Incremental run complete."
    return
}

# ======================================================================
# TARGETED MODE - re-sync only the named voucher(s), then stop.
# ======================================================================
if ($VoucherNos) {
    Invoke-Targeted
    Write-Host "Targeted run complete."
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

# A historical pull is one of MANY (one per financial year), so its files are
# stamped with the range - otherwise each year's export would overwrite the last
# one, and the live daily export along with it.
$fileTag = if ($Historical) { "{0}_{1}_to_{2}" -f $Branch, $FromDate, $ToDate } else { $Branch }
$masterPath = Join-Path $OutDir ("{0}_Master.json"       -f $fileTag)
$txnsPath   = Join-Path $OutDir ("{0}_Transactions.json" -f $fileTag)

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
    # Chunked. A whole financial year is tens of thousands of vouchers and
    # serialises past the server's body limit, which comes back as 413 with
    # NOTHING stored. Ingest upserts on branch+guid, so the same data split over
    # several POSTs lands identically - and one bad chunk costs a chunk, not the
    # year. Master rides with the first chunk only.
    $all = $txnsOut.ToArray()
    $uri = "{0}/ingest" -f $IngestUrl.TrimEnd('/')
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($IngestToken) { $headers['x-ingest-token'] = $IngestToken }
    # -Reset / -ResetAll: clear the branch BEFORE the first chunk, and only now that
    # the pull has succeeded and the files are on disk - so a Tally that answered
    # badly can never leave the branch empty. Nothing else deletes: the wrong
    # company's vouchers have their own GUIDs and no push overwrites them.
    if ($Reset -or $ResetAll) {
        $rUri = "{0}/admin/reset" -f $IngestUrl.TrimEnd('/')
        if ($ResetAll) { $rBody = [ordered]@{ branch = $Branch; all = $true } }
        else           { $rBody = [ordered]@{ branch = $Branch; from = $FromDate; to = $ToDate } }
        $scope = if ($ResetAll) { "ALL dates" } else { "{0}..{1}" -f $FromDate, $ToDate }
        Write-Host ("  Reset: clearing branch '{0}' ({1}) ..." -f $Branch, $scope)
        try {
            $rResp = Invoke-WebRequest -Uri $rUri -Method Post -Body ($rBody | ConvertTo-Json -Compress) -Headers $headers -UseBasicParsing
            Write-Host ("  Reset OK: {0}" -f $rResp.Content)
        } catch {
            Write-Warning ("  Reset FAILED: {0}" -f $_.Exception.Message)
            Write-Warning ("  Nothing will be pushed. Check {0}/api/meta before re-running: a request" -f $IngestUrl.TrimEnd('/'))
            Write-Warning "  that timed out may still have cleared the branch on the server."
            Write-Warning ("  Files are on disk at {0}; fix the URL/token and re-run." -f $OutDir)
            if ($Historical) { exit 3 }
            exit 4
        }
    }
    $total  = $all.Count
    $chunks = [int][Math]::Ceiling($total / [double]$ChunkSize)
    if ($chunks -lt 1) { $chunks = 1 }
    $sent   = 0
    $failed = $false
    for ($ci = 0; $ci -lt $chunks; $ci++) {
        $lo = $ci * $ChunkSize
        $hi = [Math]::Min($lo + $ChunkSize, $total) - 1
        # [object[]] so a one-voucher chunk still serialises as an array, not an object.
        [object[]]$slice = if ($hi -ge $lo) { @($all[$lo..$hi]) } else { @() }
        $payload = [ordered]@{
            branch  = $Branch
            from    = $FromDate
            to      = $ToDate
            vouchers= $slice
        }
        # Back-fill: this company's ledger master is the hierarchy as it stood in that
        # year. 'merge' keeps the live one intact and only files the ledgers Tally no
        # longer has, so these old vouchers still classify. See server/ingest.js.
        if ($ci -eq 0) {
            $payload.master = $masterObj
            if ($Historical) { $payload.masterMode = 'merge' }
        }
        $body = $payload | ConvertTo-Json -Depth 12 -Compress
        # Retry a chunk a few times before giving up. Over a run this long the far
        # end drops the occasional keep-alive connection ("A connection that was
        # expected to be kept alive was closed by the server"), and losing a whole
        # 34,000-voucher year to one dropped socket is absurd when the next attempt
        # succeeds. Upserts are idempotent, so a retry can only re-write the same
        # rows. A 4xx is NOT retried: a bad token or an oversized body fails the
        # same way however many times we ask.
        $attempt = 0; $maxAttempts = 4; $chunkOk = $false; $lastErr = ""
        while (-not $chunkOk -and $attempt -lt $maxAttempts) {
            $attempt++
            try {
                $resp = Invoke-WebRequest -Uri $uri -Method Post -Body $body -Headers $headers -UseBasicParsing
                $chunkOk = $true
            } catch {
                $lastErr = $_.Exception.Message
                $code = 0
                try { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } } catch { }
                if ($code -ge 400 -and $code -lt 500) { break }
                if ($attempt -lt $maxAttempts) {
                    $wait = [int][Math]::Pow(2, $attempt)   # 2s, 4s, 8s
                    Write-Warning ("  chunk {0}/{1} attempt {2}/{3} failed ({4}) - retrying in {5}s" -f ($ci + 1), $chunks, $attempt, $maxAttempts, $lastErr, $wait)
                    Start-Sleep -Seconds $wait
                }
            }
        }
        if ($chunkOk) {
            $sent += $slice.Count
            Write-Host ("  chunk {0}/{1}: {2}/{3} vouchers - {4}" -f ($ci + 1), $chunks, $sent, $total, $resp.Content)
        } else {
            Write-Warning ("  chunk {0}/{1} failed after {2} attempt(s): {3}" -f ($ci + 1), $chunks, $attempt, $lastErr)
            Write-Warning ("  {0}/{1} vouchers reached the server before this." -f $sent, $total)
            Write-Warning ("  The files are still on disk, so push them again WITHOUT re-pulling Tally:")
            # -historical matters: this is an old financial year, and without it that
            # year's ledger master would REPLACE the live hierarchy instead of merging.
            $histArg = ""
            if ($Historical) { $histArg = " --historical" }
            Write-Warning ("    node server\loader.js --dir {0} --branch {1} --url {2} --token <your-token> --chunk {3}{4}" -f $OutDir, $Branch, $IngestUrl.TrimEnd('/'), [Math]::Max(250, [int]($ChunkSize / 4)), $histArg)
            Write-Warning ("  (re-running this script also works, but re-pulls the whole range from Tally.)")
            $failed = $true
            break
        }
    }
    if (-not $failed) { Write-Host ("  Ingest OK: {0} vouchers in {1} chunk(s)." -f $sent, $chunks) }
    # A back-fill year that never reached Mongo must not look like a success, or
    # run_backfill.ps1 would tick it off and leave a silent hole in the history.
    if ($failed -and $Historical) { exit 3 }
} else {
    Write-Host "No -IngestUrl given: files written locally only."
    if ($Historical) {
        Write-Host ("Push them from an internet-connected machine with: node server/loader.js --dir <dir> --branch {0} --historical" -f $Branch)
        Write-Host ("  (--historical is REQUIRED for an old-year export, and loader.js expects the files named {0}_Master.json / {0}_Transactions.json - rename or pass one year at a time.)" -f $Branch)
    } else {
        Write-Host "Push them from an internet-connected machine with: node server/loader.js"
    }
}
