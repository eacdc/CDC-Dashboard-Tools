// Real-browser e2e: serve the actual dashboard + a stub /api/dataset built from
// the amd sample, then drive Chromium through the MongoDB-fetch flow and assert
// the dashboard renders real numbers. Proves the front-end Mongo path works.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const REPO = path.join(__dirname, '..');
const MASTER = process.argv[2], TXNS = process.argv[3];
const master = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
const vouchers = JSON.parse(fs.readFileSync(TXNS, 'utf8'));

const app = express();
app.get('/api/dataset', (req, res) => {
  const from = req.query.from || '20250401';
  const to = req.query.to || '20260716';
  const vs = vouchers.filter((v) => v.date >= from && v.date <= to)
    .map((v) => ({ date: v.date, party: v.party, no: v.no, type: v.type, ledgers: v.ledgers, party_ledgers: v.party_ledgers }));
  res.json({ from, to, branches: {
    kol: { hierarchy: { ledgers: {}, groups: {} }, vouchers: [] },
    ahm: { hierarchy: master, vouchers: vs },
  }});
});
app.use('/consolidated', express.static(path.join(REPO, 'consolidated')));

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  // The dashboards load React/xlsx/fonts from CDNs the sandbox proxy blocks.
  // Route the React CDN URLs to local npm UMD copies so the app can boot here.
  const reactJs = fs.readFileSync(path.join(__dirname, 'node_modules/react/umd/react.production.min.js'), 'utf8');
  const reactDomJs = fs.readFileSync(path.join(__dirname, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('react-dom')) return route.fulfill({ contentType: 'application/javascript', body: reactDomJs });
    if (url.includes('react.production') || url.includes('libs/react/')) return route.fulfill({ contentType: 'application/javascript', body: reactJs });
    if (url.includes('cdnjs') || url.includes('fonts.googleapis') || url.includes('fonts.gstatic')) return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    return route.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.goto(`${base}/consolidated/index.html`, { waitUntil: 'networkidle' });

  // Should default to MongoDB mode with the Fetch button present.
  await page.waitForSelector('text=Fetch from MongoDB', { timeout: 5000 });

  // Set full-FY range to pull the whole sample.
  const dates = await page.$$('input[type=date]');
  await dates[0].fill('2025-04-01');
  await dates[1].fill('2026-07-16');

  await page.click('text=Fetch from MongoDB');

  // Dashboard header appears once data is built.
  await page.waitForSelector('text=Consolidated Dashboard', { timeout: 15000 });
  await page.waitForFunction(() => /\d+ vouchers .* parties/.test(document.body.innerText), { timeout: 10000 });
  const body = await page.evaluate(() => document.body.innerText);
  const m = body.match(/(\d+) vouchers .* (\d+) inflow .* (\d+) outflow parties/);

  let fails = 0;
  const assert = (c, msg) => { if (!c) { console.error('FAIL:', msg); fails++; } else console.log('ok  -', msg); };
  assert(m && parseInt(m[1]) > 0, `dashboard built from ${m ? m[1] : '?'} vouchers (current-FY window of the range)`);
  assert(/NET PROFIT/.test(body), 'P&L rendered (NET PROFIT row present)');
  assert(/Cr|L\b/.test(body), 'real monetary figures rendered');
  assert(body.includes('CONSOLIDATED'), 'consolidated header present');
  assert(errors.length === 0, 'no page/console errors' + (errors.length ? ' -> ' + errors.slice(0, 3).join(' | ') : ''));

  // Also flip to Cashflow view to prove that tab builds too.
  await page.click('text=Cashflow');
  await page.waitForSelector('text=NET CASHFLOW', { timeout: 5000 });
  assert(true, 'Cashflow view renders');
  const headline = body.split('\n').filter((l) => /Cr|Consolidated|FY/.test(l)).slice(0, 6);
  console.log('sample lines:', JSON.stringify(headline));

  await page.screenshot({ path: path.join(__dirname, 'browser_test.png'), fullPage: false });
  await browser.close();
  server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== browser e2e passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
