#!/usr/bin/env node
// Standalone loader for the no-internet-on-Tally case: the .ps1 writes
// <branch>_Master.json + <branch>_Transactions.json to a folder; copy that folder
// to any machine that CAN reach MongoDB Atlas, then run this to push it.
//
//   MONGODB_URI="mongodb+srv://..." node loader.js --dir ./tally_export --branch ahm
//
// Or push through a running API instead of writing to Mongo directly:
//   node loader.js --dir ./tally_export --branch ahm --url https://cdc-api.onrender.com --token SECRET
//
// The API push is chunked (2000 vouchers per POST) so a full financial year doesn't
// hit the server's body limit and come back 413. Lower it with --chunk 500 if it does.
//
// Pushing an OLD financial year's export (a back-fill)? Add --historical so the old
// company's ledger master is merged into the live one instead of replacing it.
//
// Pushed the WRONG company into a branch? Add --reset (clears that branch over this
// export's date range) or --reset-all (clears the branch outright) before the push.
// A plain re-push does NOT fix it: the other company's vouchers have their own GUIDs,
// so nothing overwrites them and the branch ends up holding both companies.
require('./loadEnv');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const dir = arg('dir', '.');
  const branch = (arg('branch', '') || '').toLowerCase();
  const url = arg('url', '');
  const token = arg('token', '');
  if (!['kol', 'ahm'].includes(branch)) {
    console.error('Usage: node loader.js --dir <folder> --branch <kol|ahm> [--url <api>] [--token <secret>]');
    process.exit(1);
  }
  // Header values are ByteStrings: a non-ASCII token (a placeholder pasted verbatim,
  // a smart quote, a stray dash from a doc) throws deep inside fetch with a
  // character-code message that says nothing about the token. Catch it here, after
  // the files have loaded but before the first POST.
  if (token && /[^\x20-\x7E]/.test(token)) {
    console.error(`--token contains a character that cannot go in an HTTP header: ${JSON.stringify(token)}`);
    console.error('Looks like a placeholder was pasted verbatim. Use the real token (Render env var INGEST_TOKEN).');
    process.exit(1);
  }

  const masterPath = path.join(dir, `${branch}_Master.json`);
  const txnsPath = path.join(dir, `${branch}_Transactions.json`);
  const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
  const vouchers = JSON.parse(fs.readFileSync(txnsPath, 'utf8'));
  const dates = vouchers.map((v) => v.date).filter(Boolean).sort();
  // --historical: this export came from an OLD financial-year company, so its master
  // must not replace the live hierarchy — merge it in instead (see ingest.js).
  const historical = process.argv.includes('--historical');
  const payload = { branch, from: dates[0] || null, to: dates[dates.length - 1] || null, master, vouchers };
  if (historical) payload.masterMode = 'merge';
  console.log(`Loaded ${vouchers.length} vouchers, ${Object.keys(master.ledgers || {}).length} ledgers for "${branch}" (${payload.from}..${payload.to})${historical ? ' [historical: master merged, not replaced]' : ''}`);

  // Double-entry health check: every voucher's ledgers+party_ledgers should sum to ~0.
  // A large imbalance means postings were dropped in extraction (e.g. sales/purchase
  // lines nested under inventory accounting allocations).
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  let off = 0, maxImb = 0;
  for (const v of vouchers) {
    const bal = sum(v.ledgers) + sum(v.party_ledgers);
    if (Math.abs(bal) > 1) { off++; maxImb = Math.max(maxImb, Math.abs(bal)); }
  }
  const pct = vouchers.length ? ((off / vouchers.length) * 100).toFixed(1) : '0';
  if (off > 0) {
    console.log(`WARNING: ${off}/${vouchers.length} vouchers (${pct}%) do not balance (max off by ${maxImb.toFixed(2)}). Extraction may be dropping postings.`);
  } else {
    console.log(`balance check: all ${vouchers.length} vouchers balance to ~0 (double-entry intact).`);
  }

  if (url) {
    // Push through the HTTP API, in chunks. A full financial year is tens of
    // thousands of vouchers and serialises to well over the body limit, which the
    // server rejects with 413 and nothing lands. Ingest is idempotent (upsert on
    // branch+guid), so splitting the same data across several POSTs is equivalent
    // to one big one -- and a failure now costs one chunk, not the whole year.
    // The master rides with the first chunk only; later chunks are vouchers alone.
    const base = url.replace(/\/$/, '');
    const endpoint = `${base}/ingest`;
    const headers = { 'Content-Type': 'application/json', ...(token ? { 'x-ingest-token': token } : {}) };
    // --reset: wipe the branch first. The wrong company pulled into a branch leaves
    // vouchers with foreign GUIDs that no re-push can overwrite -- they have to be
    // deleted (see resetBranch). --reset-all widens it from this export's date range
    // to every voucher the branch holds.
    if (process.argv.includes('--reset') || process.argv.includes('--reset-all')) {
      const wipeAll = process.argv.includes('--reset-all');
      const body = wipeAll ? { branch, all: true } : { branch, from: payload.from, to: payload.to };
      const r0 = await fetch(`${base}/admin/reset`, { method: 'POST', headers, body: JSON.stringify(body) });
      const t0 = await r0.text();
      if (!r0.ok) { console.error(`reset FAILED: ${r0.status} ${t0}`); process.exit(1); }
      console.log(`reset: ${t0}`);
    }
    const size = Math.max(1, Number(arg('chunk', '2000')) || 2000);
    const chunks = Math.max(1, Math.ceil(vouchers.length / size));
    let sent = 0;
    // Retry each chunk a few times. Across a push this long the far end drops the
    // odd keep-alive connection, and losing the run to one dropped socket is absurd
    // when the next attempt succeeds. Upserts are idempotent, so a retry can only
    // re-write the same rows. A 4xx is never retried: a bad token or an oversized
    // body fails identically however many times we ask.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < chunks; i++) {
      const part = { ...payload, vouchers: vouchers.slice(i * size, (i + 1) * size) };
      if (i > 0) delete part.master;
      const body = JSON.stringify(part);
      const MAX = 4;
      let res = null, text = '', why = '';
      for (let attempt = 1; attempt <= MAX; attempt++) {
        try {
          res = await fetch(endpoint, { method: 'POST', headers, body });
          text = await res.text();
          if (res.ok) break;
          why = `${res.status} ${text}`;
          if (res.status >= 400 && res.status < 500) break;
        } catch (e) {
          res = null;
          why = e.message || String(e);
        }
        if (attempt < MAX) {
          const wait = 2 ** attempt * 1000; // 2s, 4s, 8s
          console.error(`chunk ${i + 1}/${chunks} attempt ${attempt}/${MAX} failed (${why}) - retrying in ${wait / 1000}s`);
          await sleep(wait);
        }
      }
      if (!res || !res.ok) {
        console.error(`chunk ${i + 1}/${chunks} FAILED: ${why}`);
        console.error(`Sent ${sent}/${vouchers.length} vouchers. Re-run to resume (upserts are idempotent);`);
        console.error(`if this was a 413, retry with a smaller --chunk (e.g. --chunk ${Math.max(250, Math.floor(size / 4))}).`);
        process.exit(1);
      }
      sent += part.vouchers.length;
      console.log(`chunk ${i + 1}/${chunks}: ${sent}/${vouchers.length} vouchers -> ${res.status} ${text}`);
    }
  } else {
    // Write directly to Mongo.
    const { ingest, resetBranch } = require('./ingest');
    const { close } = require('./db');
    // Same reset as the API path, so both give the same result: --reset clears this
    // export's date range, --reset-all clears the branch outright.
    if (process.argv.includes('--reset') || process.argv.includes('--reset-all')) {
      const wipeAll = process.argv.includes('--reset-all');
      const r = await resetBranch(wipeAll ? { branch, all: true } : { branch, from: payload.from, to: payload.to });
      console.log('reset:', JSON.stringify(r));
    }
    const result = await ingest(payload);
    console.log('Ingested:', JSON.stringify(result));
    await close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
