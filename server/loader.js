#!/usr/bin/env node
// Standalone loader for the no-internet-on-Tally case: the .ps1 writes
// <branch>_Master.json + <branch>_Transactions.json to a folder; copy that folder
// to any machine that CAN reach MongoDB Atlas, then run this to push it.
//
//   MONGODB_URI="mongodb+srv://..." node loader.js --dir ./tally_export --branch ahm
//
// Or push through a running API instead of writing to Mongo directly:
//   node loader.js --dir ./tally_export --branch ahm --url https://cdc-api.onrender.com --token SECRET
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

  const masterPath = path.join(dir, `${branch}_Master.json`);
  const txnsPath = path.join(dir, `${branch}_Transactions.json`);
  const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
  const vouchers = JSON.parse(fs.readFileSync(txnsPath, 'utf8'));
  const dates = vouchers.map((v) => v.date).filter(Boolean).sort();
  const payload = { branch, from: dates[0] || null, to: dates[dates.length - 1] || null, master, vouchers };
  console.log(`Loaded ${vouchers.length} vouchers, ${Object.keys(master.ledgers || {}).length} ledgers for "${branch}" (${payload.from}..${payload.to})`);

  if (url) {
    // Push through the HTTP API.
    const res = await fetch(`${url.replace(/\/$/, '')}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-ingest-token': token } : {}) },
      body: JSON.stringify(payload),
    });
    console.log('API response:', res.status, await res.text());
  } else {
    // Write directly to Mongo.
    const { ingest } = require('./ingest');
    const { getDb, close } = require('./db');
    if (process.argv.includes('--reset')) {
      const db = await getDb();
      const r = await db.collection('vouchers').deleteMany({ branch });
      console.log(`--reset: cleared ${r.deletedCount} existing "${branch}" vouchers`);
    }
    const result = await ingest(payload);
    console.log('Ingested:', JSON.stringify(result));
    await close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
