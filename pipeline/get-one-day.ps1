# Pulls the RAW Day Book XML for a single date from Tally and saves it to a file.
# View access is enough - this is an HTTP data export, not the voucher-edit screen.
# Tally must be running and sitting idle at "Gateway of Tally".

$TallyUrl = "http://localhost:9001"                 # same port your pipeline uses
$Company  = "CDC PRINTERS 2025-26"
$Ymd      = "20260112"                               # 12-Jan-26 (Debasish Book Stall Vch 32)
$OutFile  = "$env:USERPROFILE\Desktop\daybook_$Ymd.xml"

$payload = @"
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>Day Book</REPORTNAME>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>$Company</SVCURRENTCOMPANY>
      <SVCURRENTDATE>$Ymd</SVCURRENTDATE>
      <SVFROMDATE>$Ymd</SVFROMDATE>
      <SVTODATE>$Ymd</SVTODATE>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>
"@

$r = Invoke-WebRequest -Uri $TallyUrl -Method Post -Body $payload `
     -ContentType "text/xml;charset=utf-8" -UseBasicParsing -TimeoutSec 180
$r.Content | Out-File -FilePath $OutFile -Encoding UTF8
Write-Host "Saved raw XML to $OutFile"
