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
  // The name-merge the dashboards apply to every voucher before anything is added
  // up: a party renamed in Tally, or entered twice under two spellings, is one
  // party. Identity is the ledger's GUID, with the shared alias map bridging an old
  // name that no longer exists in the master. Lifted for the same reason as the
  // rest -- the year-on-year fold has to merge the same names the P&L tab merges,
  // or a customer shows up whole on one page and split in two on the other.
  { name: '__cdcCanon', re: /^window\.__cdcCanon=function\(xd,vouchers,bills\)\{[\s\S]*?\n\};$/m },
  // How the two companies' ledger tables become one. FIRST WINS -- Kolkata's answer
  // for a name that exists in both, Ahmedabad only filling the gaps -- and TPG's
  // default group parents are applied at the end. Lifted because the server built
  // the same table by hand with Object.assign, which is LAST wins: a ledger name
  // living in both companies under different groups then classified one way on the
  // P&L tab and another in the year-on-year fold.
  { name: 'mergeHierarchies', re: /^function mergeHierarchies\(h1,h2\)\{[\s\S]*?\n\}$/m },
  // The Bills Receivable / Payable CSV, as the dashboards read it. Tally's export has
  // a preamble, quoted commas and Dr/Cr suffixes, and the diagnostic has to see the
  // very same rows the projection sees -- otherwise it would explain a file nobody
  // is actually using.
  { name: 'toYMD', re: /^function toYMD\(d\)\{.*?\}$/m },
  { name: 'parseTD', re: /^function parseTD\(s\)\{.*?\}$/m },
  { name: 'parseBillsCSV', re: /^function parseBillsCSV\(text\)\{[\s\S]*?return bills;\}$/m },
];
const EXPORTS = 'TPG,PL_CATS,SKIP_ROOTS,CASH_VCH,findIBLedgers,norm,stem,buildLookups,getChain,classify,monthKey,buildTree,mergeHierarchies,parseBillsCSV';

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
  // __cdcCanon hangs itself off `window` and reads its alias map from there, so the
  // sandbox needs one. It stays reachable as `canonWindow`: the map is set on it
  // once per rebuild, just before the canonicaliser is built.
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(parts.join('\n'), { filename: 'portal-engine' }).runInContext(sandbox);
  const api = vm.runInContext('({' + EXPORTS.split(',').map((k) => k + ':' + k).join(',') + '})', sandbox);
  for (const k of Object.keys(api)) if (!api[k]) throw new Error(`plEngine: ${k} came back empty`);
  api.canonWindow = sandbox.window;
  api.makeCanon = function (xd, aliases) {
    sandbox.window.__cdcAliases = aliases || {};
    return sandbox.window.__cdcCanon(xd, null, null);   // returns the name mapper
  };
  if (typeof sandbox.window.__cdcCanon !== 'function') throw new Error('plEngine: __cdcCanon came back empty');
  return api;
}

module.exports = loadEngine();
