// Real-browser e2e for the PORTAL MongoDB flow. Serves the built portal + a stub
// /api/dataset from the amd sample, drives Chromium: fetch from Mongo, then verify
// both the Consolidated and Projected views render inside the portal shell.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const REPO = path.join(__dirname, '..');
const master = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const vouchers = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const app = express();
app.get('/api/dataset', (req, res) => {
  const from = req.query.from || '20250401', to = req.query.to || '20260716';
  const vs = vouchers.filter((v) => v.date >= from && v.date <= to);
  res.json({ from, to, branches: {
    kol: { hierarchy: { ledgers: {}, groups: {} }, vouchers: [] },
    ahm: { hierarchy: master, vouchers: vs },
  }});
});
app.use('/portal', express.static(path.join(REPO, 'portal')));

(async () => {
  const server = app.listen(0); await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const reactJs = fs.readFileSync(path.join(__dirname, 'node_modules/react/umd/react.production.min.js'), 'utf8');
  const reactDomJs = fs.readFileSync(path.join(__dirname, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('react-dom')) return route.fulfill({ contentType: 'application/javascript', body: reactDomJs });
    if (url.includes('react.production') || url.includes('libs/react/')) return route.fulfill({ contentType: 'application/javascript', body: reactJs });
    if (url.includes('cdnjs') || url.includes('fonts.g')) return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    return route.continue();
  });

  await page.goto(`http://127.0.0.1:${port}/portal/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Fetch from MongoDB → Open Portal', { timeout: 5000 });
  const dates = await page.$$('input[type=date]');
  await dates[0].fill('2025-04-01');
  await dates[1].fill('2026-07-16');
  await page.click('text=Fetch from MongoDB → Open Portal');

  // Portal chrome appears (nav with both views).
  await page.waitForSelector('text=CDC FINANCE', { timeout: 15000 });
  await page.waitForFunction(() => /vouchers/.test(document.body.innerText), { timeout: 10000 });
  const consolText = await page.evaluate(() => document.body.innerText);

  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
  assert(/CDC FINANCE/.test(consolText), 'portal chrome rendered');
  assert(/NET PROFIT/.test(consolText), 'default Consolidated view shows P&L');
  assert(/Cr|L\b/.test(consolText), 'real figures rendered');

  // Switch to Projected view within the portal.
  await page.click('text=Projected (Projection / Receivables / Payables / PvA)');
  await page.waitForSelector('text=Cash Intelligence Dashboard', { timeout: 8000 });
  assert(true, 'Projected view renders inside portal');

  assert(errors.length === 0, 'no page/console errors' + (errors.length ? ' -> ' + errors.slice(0, 3).join(' | ') : ''));
  console.log('sample:', JSON.stringify(consolText.split('\n').filter((l) => /Cr|FINANCE|FY/.test(l)).slice(0, 4)));

  await browser.close(); server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== portal browser e2e passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
