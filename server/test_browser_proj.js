// Real-browser e2e for the PROJECTED dashboard MongoDB flow. Serves the stub API
// + static page, drives Chromium: sets as-of date, fetches from Mongo (no bills),
// asserts the projection dashboard renders.
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
app.use('/projected', express.static(path.join(REPO, 'projected')));

(async () => {
  const server = app.listen(0); await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const reactJs = fs.readFileSync(path.join(__dirname, 'node_modules/react/umd/react.production.min.js'), 'utf8');
  const reactDomJs = fs.readFileSync(path.join(__dirname, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('react-dom')) return route.fulfill({ contentType: 'application/javascript', body: reactDomJs });
    if (url.includes('react.production') || url.includes('libs/react/')) return route.fulfill({ contentType: 'application/javascript', body: reactJs });
    if (url.includes('cdnjs') || url.includes('fonts.g')) return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    return route.continue();
  });

  await page.goto(`http://127.0.0.1:${port}/projected/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Fetch from MongoDB + Analyze', { timeout: 5000 });
  // as-of date within the loaded FY so there are vouchers to project from
  const dates = await page.$$('input[type=date]');
  await dates[0].fill('2026-07-05');
  await page.click('text=Fetch from MongoDB + Analyze');

  // Projection dashboard shows a "Cash Intelligence" header once built.
  await page.waitForSelector('text=Cash Intelligence Dashboard', { timeout: 15000 });
  const body = await page.evaluate(() => document.body.innerText);

  let fails = 0;
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok  -', m); };
  assert(/Cash Intelligence Dashboard/.test(body), 'projection dashboard rendered');
  assert(/as of/i.test(body), 'as-of header present');
  assert(errors.length === 0, 'no page/console errors' + (errors.length ? ' -> ' + errors.slice(0, 3).join(' | ') : ''));
  console.log('sample:', JSON.stringify(body.split('\n').filter((l) => /Cr|as of|Projected|INFLOW/i.test(l)).slice(0, 5)));

  await browser.close(); server.close();
  console.log(fails ? `\n== ${fails} FAILURES ==` : '\n== projected browser e2e passed ==');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
