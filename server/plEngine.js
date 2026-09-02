// The dashboard's own classification rules, running in Node.
//
// Which ledger counts as revenue, purchase, direct or indirect expense is decided by
// walking its group chain (Sales Accounts -> Revenue Account, and so on). That logic
// lives in the browser bundle, and the year-on-year summary has to agree with the
// P&L tab to the paisa or it is worse than useless.
//
// So it is not re-implemented here: the exact function bodies are lifted out of
// portal/index.html and evaluated. One source of truth, and a rename in the portal
// fails loudly at startup instead of silently drifting the numbers apart.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORTAL = path.join(__dirname, '..', 'portal', 'index.html');

// Every symbol the fold needs, each as it is declared in the portal. Order follows
// the file; function declarations hoist and the `var` tables are only read from
// inside those functions, so one evaluation of the lot is enough.
const WANTED = [
  { name: 'TPG', re: /^var TPG=\{.*?\};$/m },
  { name: 'PL_CATS', re: /^var PL_CATS=\{.*?\};$/m },
  { name: 'SKIP_ROOTS', re: /^var SKIP_ROOTS=\{.*?\};$/m },
  { name: 'CASH_VCH', re: /^var CASH_VCH=\{.*?\};$/m },
  { name: 'findIBLedgers', re: /^function findIBLedgers\(xd\)\{[\s\S]*?\n\}$/m },
  { name: 'getChainRaw', re: /^function getChainRaw\(name,xd\)\{[\s\S]*?\n\}$/m },
  { name: 'norm', re: /^function norm\(s\)\{.*?\}$/m },
  { name: 'stem', re: /^function stem\(s\)\{.*?\}$/m },
  { name: 'buildLookups', re: /^function buildLookups\(xd\)\{.*?\}$/m },
  { name: 'findParent', re: /^function findParent\(name,xd,lu\)\{.*?\}$/m },
  { name: 'getChain', re: /^function getChain\(name,xd,lu\)\{[\s\S]*?\n\}$/m },
  { name: 'classify', re: /^function classify\(name,xd,lu,overrides\)\{.*?\}$/m },
  { name: 'monthKey', re: /^function monthKey\(ds,startFY\)\{.*?\}$/m },
  // buildTree turns ledger -> monthly[] into the nested group tree the P&L tab draws.
  // The year-on-year drill-down shows that same tree, so it is lifted rather than
  // rebuilt: one shape, one ordering, one set of group roll-ups.
  { name: 'buildTree', re: /^function buildTree\(ledgerData,xd,lu,monthCount\)\{[\s\S]*?\n\}$/m },
];
const EXPORTS = 'TPG,PL_CATS,SKIP_ROOTS,CASH_VCH,findIBLedgers,norm,stem,buildLookups,getChain,classify,monthKey,buildTree';

function loadEngine() {
  const html = fs.readFileSync(PORTAL, 'utf8');
  const parts = [];
  for (const w of WANTED) {
    const m = html.match(w.re);
    if (!m) {
      throw new Error(
        `plEngine: could not find "${w.name}" in portal/index.html. The dashboard's ` +
        'classification was renamed or reshaped -- update WANTED here, and re-run ' +
        'npm run test:yoy, which checks the server figures still match the browser.');
    }
    parts.push(m[0]);
  }
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(parts.join('\n'), { filename: 'portal-engine' }).runInContext(sandbox);
  const api = vm.runInContext('({' + EXPORTS.split(',').map((k) => k + ':' + k).join(',') + '})', sandbox);
  for (const k of Object.keys(api)) if (!api[k]) throw new Error(`plEngine: ${k} came back empty`);
  return api;
}

module.exports = loadEngine();
