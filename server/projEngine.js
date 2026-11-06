// projEngine.js -- lift the receivables / projection engine out of portal/index.html
// and run it in Node, so it can be tested without a browser.
//
// WHY BY REGEX, like plEngine.js. The outstanding a customer owes is computed in the
// browser, inside `buildProjection`, and that is the only place it may be computed:
// a second copy here, free to drift, is how the portal and a test come to disagree
// about what a party owes while both look right. So the real function is lifted out of
// the real page and run as-is. Rename or reshape it and the lift throws a named error
// -- deliberately, exactly as with plEngine: the fix is to update WANTED here, never to
// re-implement the engine.
//
// This module is required by the tests, not by the server, so a rename fails
// `npm run test:proj` by name instead of taking the service down at startup.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORTAL = path.join(__dirname, '..', 'portal', 'index.html');

// Each piece the engine needs, in dependency order. Single-line functions are matched
// to the end of their line; `buildProjection` is anchored on its signature and on the
// `return{projMonths:...}` that closes it.
const WANTED = [
  { name: 'getChain', re: /^function getChain\(n,xd\)\{.*\}$/m },
  { name: 'chainHas', re: /^function chainHas\(n,xd,kws\)\{.*\}$/m },
  { name: 'findIB', re: /^function findIB\(xd\)\{.*\}$/m },
  { name: 'parseDate', re: /^function parseDate\(ds\)\{.*\}$/m },
  { name: 'daysBtw', re: /^function daysBtw\(d1,d2\)\{.*\}$/m },
  { name: 'addDays', re: /^function addDays\(d,n\)\{.*\}$/m },
  { name: 'toYMD', re: /^function toYMD\(d\)\{.*\}$/m },
  { name: 'isSaleVt', re: /^function isSaleVt\(vt\)\{.*\}$/m },
  { name: 'isPurchVt', re: /^function isPurchVt\(vt\)\{.*\}$/m },
  { name: 'isDNVt', re: /^function isDNVt\(vt\)\{.*\}$/m },
  { name: 'isCNVt', re: /^function isCNVt\(vt\)\{.*\}$/m },
  { name: 'NOPOST', re: /^var NOPOST=\[[\s\S]*?\];$/m },
  { name: 'isNoPostVt', re: /^function isNoPostVt\(vt\)\{.*\}$/m },
  { name: 'getGrp', re: /^function getGrp\(.*?\)\{.*\}$/m },
  { name: 'buildProjection',
    re: /^function buildProjection\(vouchers,xd,ib,recBills,payBills,asOfDate\)\{[\s\S]*?^return\{projMonths:[\s\S]*?\};\};$/m },
];

function build() {
  const html = fs.readFileSync(PORTAL, 'utf8');
  const parts = [];
  for (const w of WANTED) {
    const m = html.match(w.re);
    if (!m) {
      throw new Error(
        `projEngine: could not find "${w.name}" in portal/index.html. The receivables ` +
        'engine was renamed or reshaped -- update WANTED here, and re-run ' +
        'npm run test:proj, which checks what a party owes still comes out right.');
    }
    parts.push(m[0]);
  }
  // The engine writes its diagnostics onto `window` and logs a voucher sample. Give it
  // both rather than stubbing them out of the source: the code that runs here has to be
  // the code the browser runs.
  const sandbox = { window: {}, console: { log() {} } };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(parts.join('\n') + '\n;({buildProjection,findIB,toYMD,getChain,chainHas});',
    sandbox, { filename: 'portal-projection.js' });
  const api = vm.runInContext('({buildProjection:buildProjection,findIB:findIB,toYMD:toYMD,' +
    'getChain:getChain,chainHas:chainHas})', sandbox);
  api.window = sandbox.window;
  return api;
}

let cached = null;
module.exports = function projEngine() {
  if (!cached) cached = build();
  return cached;
};
