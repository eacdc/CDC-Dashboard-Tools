#!/usr/bin/env node
// One-time DB provisioning + connection check.
// Creates the `masters` and `vouchers` collections and their indexes in the
// database named by MONGODB_URI (or MONGODB_DB). Safe to re-run.
//
//   cd server
//   node init_db.js
//
// NOTE: this connects AS the user in your URI -- it cannot create that Atlas
// login. Create the database user in Atlas (Database Access) first.
require('./loadEnv');
const { getDb, close } = require('./db');

(async () => {
  if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI (server/.env) first.'); process.exit(2); }
  try {
    const db = await getDb();            // getDb() also builds the indexes on connect
    const existing = (await db.listCollections().toArray()).map((c) => c.name);
    for (const name of ['masters', 'vouchers']) {
      if (!existing.includes(name)) { await db.createCollection(name); console.log(`created collection: ${name}`); }
      else { console.log(`collection exists: ${name}`); }
    }
    // Ensure indexes (idempotent).
    await db.collection('vouchers').createIndex({ branch: 1, date: 1 });
    await db.collection('vouchers').createIndex({ branch: 1, guid: 1 }, { unique: true });
    await db.collection('masters').createIndex({ branch: 1 }, { unique: true });

    const counts = {
      masters: await db.collection('masters').countDocuments(),
      vouchers: await db.collection('vouchers').countDocuments(),
    };
    console.log(`\nDatabase "${db.databaseName}" is ready.`);
    console.log(`  masters:  ${counts.masters} docs`);
    console.log(`  vouchers: ${counts.vouchers} docs`);
    console.log('\nConnection OK. Next: load data with `node loader.js --dir <folder> --branch <kol|ahm>`.');
    await close();
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    if (/Authentication failed/i.test(e.message)) {
      console.error('-> The DB user in MONGODB_URI is wrong or does not exist. Create it in Atlas (Database Access).');
    } else if (/ECONNREFUSED.*_mongodb._tcp/i.test(e.message) || /querySrv/i.test(e.message)) {
      console.error('-> DNS cannot resolve the SRV record. Use the standard mongodb:// (non-+srv) connection string.');
    } else if (/Server selection timed out/i.test(e.message)) {
      console.error('-> Cannot reach the cluster. Add your IP to Atlas Network Access.');
    }
    await close();
    process.exit(1);
  }
})();
