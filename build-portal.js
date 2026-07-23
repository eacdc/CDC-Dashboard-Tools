// Build script: assemble portal/index.html from consolidated + projected apps.
// Each app's inline React script is wrapped in an isolated IIFE namespace so their
// many same-named functions (processData, Dash, Row, fmt, ...) never collide.
// A thin shell handles a single upload and switches between the two apps' Dash.
// Run: node build-portal.js
const fs = require('fs');
const path = require('path');

function lastInlineScript(html) {
  // Find all <script>...</script> WITHOUT a src attribute; return the last one's body.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, last = null;
  while ((m = re.exec(html)) !== null) last = m[1];
  if (!last) throw new Error('no inline script found');
  return last;
}
function styleBlocks(html) {
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m, out = [];
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out.join('\n');
}
// Strip the trailing mount so the IIFE can `return` its symbols instead.
function stripMount(body) {
  // Remove the ErrorBoundary render + ReactDOM.render(...) tail (projected) or plain ReactDOM.render (consolidated).
  return body
    .replace(/ReactDOM\.render\([\s\S]*?document\.getElementById\(['"]root['"]\)\);?/g, '')
    .trim();
}

const root = __dirname;
const consolHtml = fs.readFileSync(path.join(root, 'consolidated', 'index.html'), 'utf8');
const projHtml   = fs.readFileSync(path.join(root, 'projected',   'index.html'), 'utf8');

let consolBody = stripMount(lastInlineScript(consolHtml));
let projBody   = stripMount(lastInlineScript(projHtml));

// Adapter appended INSIDE each namespace: builds the app's data object from raw file texts,
// reusing that app's OWN parse/build functions (mergeHierarchies vs mergeH, etc).
const consolAdapter = `
;window.CDC_CONSOL={
  Dash: Dash,
  build: function(t, stockText){
    var kxd=parseHierarchy(t.kolHier), axd=parseHierarchy(t.ahmHier);
    var xd=mergeHierarchies(kxd,axd); var ibLedgers=findIBLedgers(xd);
    var kV=JSON.parse(t.kolVouch); for(var i=0;i<kV.length;i++)kV[i]._branch='kol';
    var aV=JSON.parse(t.ahmVouch); for(var j=0;j<aV.length;j++)aV[j]._branch='ahm';
    var vouchers=kV.concat(aV);
    var stock=stockText?parseStock(stockText):null;
    var data=processData(vouchers,xd,stock,ibLedgers,12,0,'all');
    data.branchStats={kol:kV.length,ahm:aV.length,ibElim:Object.keys(ibLedgers).length};
    data._raw={vouchers:vouchers,xd:xd,stock:stock,ibLedgers:ibLedgers};
    return data;
  }
};`;

const projAdapter = `
;window.CDC_PROJ={
  Dash: Dash,
  build: function(t, asOfStr){
    var kx=parseHierarchy(t.kolHier), ax=parseHierarchy(t.ahmHier);
    var xd=mergeH(kx,ax), ib=findIB(xd);
    var kV=JSON.parse(t.kolVouch), aV=JSON.parse(t.ahmVouch), vs=kV.concat(aV);
    var rb=parseBillsCSV(t.kolBillsRecv||''), pb=parseBillsCSV(t.kolBillsPay||'');
    if(t.ahmBillsPay) pb=pb.concat(parseBillsCSV(t.ahmBillsPay));
    var asOf=asOfStr?new Date(asOfStr+'T00:00:00'):new Date();
    return {proj:buildProjection(vs,xd,ib,rb,pb,asOf), vs:vs, xd:xd, ib:ib, rb:rb, pb:pb};
  }
};`;

const consolNS = '(function(){\n' + consolBody + '\n' + consolAdapter + '\n})();';
const projNS   = '(function(){\n' + projBody   + '\n' + projAdapter   + '\n})();';

// Shared styles (both apps' :root palettes — same base, projected/consolidated add a few extras).
const css = styleBlocks(consolHtml) + '\n' + styleBlocks(projHtml);

const APP_VERSION = 'v1.1';
const APP_BUILD = '21-Jul-2026';

const shell = `
var e=React.createElement,useState=React.useState,useRef=React.useRef;
function fmtK(n){if(n===0)return'0';var a=Math.abs(n),s=n<0?'-':'';if(a>=1e7)return s+(a/1e7).toFixed(2)+' Cr';if(a>=1e5)return s+(a/1e5).toFixed(2)+' L';if(a>=1e3)return s+(a/1e3).toFixed(1)+' K';return s+Math.round(a);}
function fyStartISOP(dt){var y=dt.getFullYear(),m=dt.getMonth()+1;var fy=m>=4?y:y-1;return fy+'-04-01';}
function ymdP(s){return (s||'').replace(/-/g,'');}
var BILL_KEYS=['kolBillsRecv','kolBillsPay','ahmBillsPay','stock'];
function lcGet(k){try{return window.localStorage?localStorage.getItem('cdc_portal_'+k):null;}catch(e){return null;}}
function lcSet(k,v){try{if(window.localStorage)localStorage.setItem('cdc_portal_'+k,v);}catch(e){}}
function FileSlot(pr){var ref=useRef();var cached=pr.cached;return e('div',{onClick:function(){ref.current&&ref.current.click();},style:{padding:'9px 12px',marginTop:'4px',borderRadius:'8px',border:pr.val?'2px solid #0891b2':(cached?'2px solid #d97706':'1px dashed #cbd5e1'),background:pr.val?'#f8fafc':(cached?'#fffbeb':'#fff'),cursor:'pointer'}},
  e('input',{ref:ref,type:'file',accept:pr.accept,style:{display:'none'},onChange:function(ev){ev.target.files&&ev.target.files[0]&&pr.onFile(ev.target.files[0]);}}),
  e('div',{style:{display:'flex',alignItems:'center',gap:'9px'}},e('span',{style:{fontSize:'15px'}},pr.val?'✅':(cached?'💾':pr.icon)),
    e('div',null,e('div',{style:{fontSize:'12px',fontWeight:600,color:pr.val?'#0891b2':(cached?'#d97706':'#475569')}},pr.val?pr.val.name:pr.label),
      e('div',{style:{fontSize:'9px',color:'#94a3b8',marginTop:'1px'}},pr.val?(pr.val.size/1048576).toFixed(1)+' MB':(cached?'Cached · click to replace':pr.hint)))));}

function Portal(){
  var sFiles=useState({}),files=sFiles[0],setFiles=sFiles[1];
  var sAsOf=useState(new Date().toISOString().slice(0,10)),asOf=sAsOf[0],setAsOf=sAsOf[1];
  var sBuilt=useState(null),built=sBuilt[0],setBuilt=sBuilt[1];// {texts, stockText, asOf}
  var sActive=useState('consol'),active=sActive[0],setActive=sActive[1];
  var sConsol=useState(null),consolData=sConsol[0],setConsolData=sConsol[1];
  var sProj=useState(null),projData=sProj[0],setProjData=sProj[1];
  var sErr=useState(null),err=sErr[0],setErr=sErr[1];
  var sLd=useState(false),ld=sLd[0],setLd=sLd[1];
  var sMode=useState('mongo'),mode=sMode[0],setMode=sMode[1];
  var sApi=useState(''),apiBase=sApi[0],setApiBase=sApi[1];
  var sFrom=useState('2025-04-01'),fromD=sFrom[0],setFromD=sFrom[1];// full history default; change here to switch back to current-FY-only
  var sTo=useState(new Date().toISOString().slice(0,10)),toD=sTo[0],setToD=sTo[1];
  function setF(k){return function(file){var nf=Object.assign({},files);nf[k]=file;setFiles(nf);};}
  // cached bills/stock text
  var cachedTexts={};BILL_KEYS.forEach(function(k){var c=lcGet(k);if(c)cachedTexts[k]=c;});

  function go(){
    setErr(null);setLd(true);
    // File-upload mode: no live API, so the per-voucher View/PDF link is unavailable.
    try{window.__cdcFromApi=false;}catch(e){}
    var need=['kolHier','ahmHier','kolVouch','ahmVouch'];
    for(var i=0;i<need.length;i++){if(!files[need[i]]){setErr('Please upload all four JSON files (Kol + Ahm hierarchy & vouchers).');setLd(false);return;}}
    var keys=['kolHier','ahmHier','kolVouch','ahmVouch','kolBillsRecv','kolBillsPay','ahmBillsPay','stock'];
    var proms=keys.map(function(k){if(files[k])return files[k].text();if(cachedTexts[k])return Promise.resolve(cachedTexts[k]);return Promise.resolve(null);});
    Promise.all(proms).then(function(r){
      var texts={kolHier:r[0],ahmHier:r[1],kolVouch:r[2],ahmVouch:r[3],kolBillsRecv:r[4],kolBillsPay:r[5],ahmBillsPay:r[6]};
      var stockText=r[7];
      // Cache bills + stock text for next session
      BILL_KEYS.forEach(function(k,idx){var v=[r[4],r[5],r[6],r[7]][idx];if(files[k]&&v)lcSet(k,v);});
      setTimeout(function(){try{
        var cd=window.CDC_CONSOL.build(texts, stockText);
        var pd=window.CDC_PROJ.build(texts, asOf);
        setConsolData(cd);setProjData(pd);setBuilt({texts:texts,stockText:stockText,asOf:asOf});setLd(false);
      }catch(ex){setErr((ex&&ex.message||ex)+'\\n'+(ex&&ex.stack||''));setLd(false);}},30);
    }).catch(function(ex){setErr(ex.message||String(ex));setLd(false);});
  }
  function goMongo(){
    setErr(null);setLd(true);
    var base=(apiBase||'').replace(/\\/+$/,'');
    // API-backed: remember the base so the drill-down can link each voucher to
    // its printable invoice/journal at <base>/voucher/ (enables View/PDF buttons).
    try{window.__cdcFromApi=true;window.__cdcApiBase=base;}catch(e){}
    var url=base+'/api/dataset?from='+ymdP(fromD)+'&to='+ymdP(toD)+'&branch=all';
    var bkeys=['kolBillsRecv','kolBillsPay','ahmBillsPay','stock'];
    var billProms=bkeys.map(function(k){if(files[k])return files[k].text();if(cachedTexts[k])return Promise.resolve(cachedTexts[k]);return Promise.resolve(null);});
    Promise.all(billProms).then(function(br){
      fetch(url).then(function(r){if(!r.ok)throw new Error('API '+r.status+' '+r.statusText);return r.json();}).then(function(d){
        var b=d.branches||{},kol=b.kol||{},ahm=b.ahm||{};
        var nk=(kol.vouchers||[]).length,na=(ahm.vouchers||[]).length;
        if(nk+na===0){setErr('No vouchers in that range. Load data via the pipeline first, or widen the range.');setLd(false);return;}
        var texts={
          kolHier:JSON.stringify(kol.hierarchy||{groups:{},ledgers:{}}),
          ahmHier:JSON.stringify(ahm.hierarchy||{groups:{},ledgers:{}}),
          kolVouch:JSON.stringify(kol.vouchers||[]),
          ahmVouch:JSON.stringify(ahm.vouchers||[]),
          kolBillsRecv:br[0],kolBillsPay:br[1],ahmBillsPay:br[2]
        };
        var stockText=br[3];
        setTimeout(function(){try{
          var cd=window.CDC_CONSOL.build(texts,stockText);
          var pd=window.CDC_PROJ.build(texts,toD);
          setConsolData(cd);setProjData(pd);setBuilt({texts:texts,stockText:stockText,asOf:toD});setLd(false);
        }catch(ex){setErr((ex&&ex.message||ex)+'\\n'+(ex&&ex.stack||''));setLd(false);}},30);
      }).catch(function(ex){setErr('Fetch failed: '+ex.message);setLd(false);});
    });
  }
  function rebuildProj(newAsOf){setAsOf(newAsOf);if(built){try{setProjData(window.CDC_PROJ.build(built.texts,newAsOf));}catch(ex){}}}
  function reset(){setBuilt(null);setConsolData(null);setProjData(null);setFiles({});}

  if(!built){
    return e('div',{style:{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#f8fafc',padding:'20px',fontFamily:'Inter,-apple-system,sans-serif'}},
      e('div',{style:{width:'660px',padding:'28px',background:'#fff',border:'1px solid #e2e8f0',borderRadius:'16px',boxShadow:'0 8px 32px rgba(0,0,0,0.06)'}},
        e('div',{style:{textAlign:'center',marginBottom:'16px'}},
          e('div',{style:{fontSize:'10px',letterSpacing:'4px',color:'#94a3b8',textTransform:'uppercase',fontFamily:'monospace'}},'CDC FINANCE PORTAL'),
          e('h1',{style:{fontSize:'22px',fontWeight:700,margin:'4px 0 0'}},'One Upload → Every View'),
          e('p',{style:{color:'#64748b',fontSize:'12px',marginTop:'4px'}},'P&L · Cashflow · Ledger Audit · Projection · Receivables · Payables · Pred vs Actual'),
          e('div',{style:{marginTop:'8px',padding:'4px 10px',display:'inline-block',background:'#ecfdf5',border:'1px solid #a7f3d0',borderRadius:'12px',fontSize:'10px',fontFamily:'monospace',color:'#047857',letterSpacing:'1px'}},'${APP_VERSION} · ${APP_BUILD}')),
        e('div',{style:{display:'flex',borderRadius:'8px',overflow:'hidden',border:'1px solid #cbd5e1',marginBottom:'14px'}},
          ['mongo','upload'].map(function(mm){var lbl=mm==='mongo'?'🗄 MongoDB (auto)':'📁 Upload files';return e('span',{key:mm,onClick:function(){setMode(mm);setErr(null);},style:{flex:1,textAlign:'center',padding:'8px 10px',cursor:'pointer',fontSize:'12px',fontFamily:'monospace',fontWeight:700,background:mode===mm?'#0891b2':'#f1f5f9',color:mode===mm?'#fff':'#475569'}},lbl);})),
        mode==='mongo'&&e('div',{style:{marginBottom:'4px'}},
          e('div',{style:{fontSize:'11px',color:'#475569',marginBottom:'8px',lineHeight:1.5}},'Fetches Kolkata + Ahmedabad data from the pipeline database for the range below (default: current FY to date). Bills CSVs stay optional (for projection).'),
          e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px'}},
            e('div',null,e('div',{style:{fontSize:'9px',fontWeight:700,color:'#94a3b8',fontFamily:'monospace'}},'FROM'),e('input',{type:'date',value:fromD,onChange:function(ev){setFromD(ev.target.value);},style:{width:'100%',padding:'8px 10px',border:'1px solid #e2e8f0',borderRadius:'8px',fontFamily:'monospace',fontSize:'12px'}})),
            e('div',null,e('div',{style:{fontSize:'9px',fontWeight:700,color:'#94a3b8',fontFamily:'monospace'}},'TO / AS-OF'),e('input',{type:'date',value:toD,onChange:function(ev){setToD(ev.target.value);},style:{width:'100%',padding:'8px 10px',border:'1px solid #e2e8f0',borderRadius:'8px',fontFamily:'monospace',fontSize:'12px'}}))),
          e('div',{style:{marginTop:'8px'}},e('div',{style:{fontSize:'9px',fontWeight:700,color:'#94a3b8',fontFamily:'monospace'}},'API BASE URL (blank = same server)'),e('input',{type:'text',value:apiBase,placeholder:'e.g. https://cdc-dashboard-api.onrender.com',onChange:function(ev){setApiBase(ev.target.value);},style:{width:'100%',padding:'8px 10px',border:'1px solid #e2e8f0',borderRadius:'8px',fontFamily:'monospace',fontSize:'12px'}}))),
        mode==='upload'&&e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px'}},
          e('div',null,e('div',{style:{fontSize:'10px',fontWeight:700,color:'#0891b2',fontFamily:'monospace',letterSpacing:'1px'}},'KOLKATA'),
            e(FileSlot,{label:'Hierarchy JSON',hint:'kol_hierarchy.json',accept:'.json',val:files.kolHier,onFile:setF('kolHier'),icon:'📋'}),
            e(FileSlot,{label:'Vouchers JSON',hint:'kol_vouchers.json',accept:'.json',val:files.kolVouch,onFile:setF('kolVouch'),icon:'📊'})),
          e('div',null,e('div',{style:{fontSize:'10px',fontWeight:700,color:'#7c3aed',fontFamily:'monospace',letterSpacing:'1px'}},'AHMEDABAD'),
            e(FileSlot,{label:'Hierarchy JSON',hint:'ahm_hierarchy.json',accept:'.json',val:files.ahmHier,onFile:setF('ahmHier'),icon:'📋'}),
            e(FileSlot,{label:'Vouchers JSON',hint:'ahm_vouchers.json',accept:'.json',val:files.ahmVouch,onFile:setF('ahmVouch'),icon:'📊'}))),
        e('div',{style:{marginTop:'12px',fontSize:'10px',fontWeight:700,color:'#d97706',fontFamily:'monospace',letterSpacing:'1px'}},'BILL-WISE (for Projection / Receivables / Payables)'),
        e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'8px'}},
          e(FileSlot,{label:'Kol Bills Receivable',hint:'CSV',accept:'.csv',val:files.kolBillsRecv,cached:!files.kolBillsRecv&&!!cachedTexts.kolBillsRecv,onFile:setF('kolBillsRecv'),icon:'📄'}),
          e(FileSlot,{label:'Kol Bills Payable',hint:'CSV',accept:'.csv',val:files.kolBillsPay,cached:!files.kolBillsPay&&!!cachedTexts.kolBillsPay,onFile:setF('kolBillsPay'),icon:'📄'}),
          e(FileSlot,{label:'Ahm Bills Payable',hint:'CSV opt.',accept:'.csv',val:files.ahmBillsPay,cached:!files.ahmBillsPay&&!!cachedTexts.ahmBillsPay,onFile:setF('ahmBillsPay'),icon:'📄'})),
        e('div',{style:{marginTop:'8px',fontSize:'10px',fontWeight:700,color:'#059669',fontFamily:'monospace',letterSpacing:'1px'}},'STOCK (for P&L stock change) + AS-OF DATE'),
        e('div',{style:{display:'grid',gridTemplateColumns:'1.4fr 1fr',gap:'8px',alignItems:'center'}},
          e(FileSlot,{label:'Stock Template CSV',hint:'optional',accept:'.csv',val:files.stock,cached:!files.stock&&!!cachedTexts.stock,onFile:setF('stock'),icon:'📦'}),
          e('div',{style:{display:'flex',flexDirection:'column',gap:'2px',marginTop:'4px'}},e('span',{style:{fontSize:'9px',color:'#94a3b8',fontFamily:'monospace'}},'AS-OF DATE (projection)'),
            e('input',{type:'date',value:asOf,onChange:function(ev){setAsOf(ev.target.value);},style:{padding:'8px 10px',border:'1px solid #e2e8f0',borderRadius:'8px',fontFamily:'monospace',fontSize:'12px'}}))),
        err&&e('div',{style:{padding:'10px',borderRadius:'8px',background:'#fef2f2',border:'1px solid #fecaca',color:'#dc2626',marginTop:'10px',fontSize:'11px',fontFamily:'monospace',whiteSpace:'pre-wrap'}},err),
        e('button',{onClick:mode==='mongo'?goMongo:go,disabled:ld,style:{width:'100%',marginTop:'14px',padding:'13px',borderRadius:'10px',border:'none',fontSize:'14px',fontWeight:600,cursor:ld?'wait':'pointer',background:ld?'#94a3b8':'#0891b2',color:'#fff'}},ld?(mode==='mongo'?'Fetching…':'Building all views…'):(mode==='mongo'?'Fetch from MongoDB → Open Portal':'Open Portal'))));
  }

  // Portal chrome + active app
  function navBtn(id,label,color){return e('button',{key:id,onClick:function(){setActive(id);},style:{padding:'8px 18px',borderRadius:'8px',border:active===id?('2px solid '+color):'1px solid #e2e8f0',background:active===id?color:'#fff',color:active===id?'#fff':'#475569',fontSize:'12px',fontFamily:'monospace',fontWeight:700,cursor:'pointer',letterSpacing:'0.5px'}},label);}
  var activeEl=active==='consol'
    ? e(window.CDC_CONSOL.Dash,{data:consolData,setData:setConsolData,onReset:reset})
    : e(window.CDC_PROJ.Dash,{data:projData,onReset:reset});
  return e('div',{style:{minHeight:'100vh',background:'#fff'}},
    e('div',{style:{display:'flex',alignItems:'center',gap:'10px',padding:'10px 20px',borderBottom:'2px solid #e2e8f0',background:'#f8fafc',position:'sticky',top:0,zIndex:200,flexWrap:'wrap'}},
      e('span',{style:{fontSize:'11px',fontWeight:700,color:'#0f172a',fontFamily:'monospace',letterSpacing:'1px',marginRight:'6px'}},'CDC FINANCE'),
      navBtn('consol','📘 Consolidated (P&L / Cashflow / Audit)','#0891b2'),
      navBtn('proj','📈 Projected (Projection / Receivables / Payables / PvA)','#be185d'),
      active==='proj'?e('div',{style:{display:'flex',alignItems:'center',gap:'5px',marginLeft:'6px'}},e('span',{style:{fontSize:'9px',color:'#94a3b8',fontFamily:'monospace'}},'as-of'),e('input',{type:'date',value:asOf,onChange:function(ev){rebuildProj(ev.target.value);},style:{padding:'4px 8px',border:'1px solid #e2e8f0',borderRadius:'6px',fontFamily:'monospace',fontSize:'11px'}})):null,
      e('button',{onClick:reset,style:{marginLeft:'auto',padding:'6px 12px',borderRadius:'6px',border:'1px solid #e2e8f0',background:'#fff',color:'#64748b',fontSize:'11px',fontFamily:'monospace',cursor:'pointer'}},'↩ New upload')),
    e('div',{key:active},activeEl));
}
ReactDOM.render(e(Portal),document.getElementById('root'));
`;

const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>CDC Finance Portal ${APP_VERSION} (${APP_BUILD})</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></scr`+`ipt>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></scr`+`ipt>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></scr`+`ipt>
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script>
${consolNS}
${projNS}
${shell}
</scr`+`ipt>
</body>
</html>`;

fs.mkdirSync(path.join(root, 'portal'), { recursive: true });
fs.writeFileSync(path.join(root, 'portal', 'index.html'), out, 'utf8');
console.log('Wrote portal/index.html (' + out.length + ' bytes)');
