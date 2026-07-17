// Mongo connection + collection helpers. One shared client for the process.
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || '';
// Empty -> fall back to the database named in the URI (e.g. .../Tally_Live).
const DB_NAME = process.env.MONGODB_DB || '';

if (!URI) {
  console.error('FATAL: MONGODB_URI is not set. Copy .env.example to .env and fill it in, or set it in the host env.');
}

let client;
let dbPromise;

function getDb() {
  if (!dbPromise) {
    client = new MongoClient(URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
    dbPromise = client.connect().then(async (c) => {
      const db = DB_NAME ? c.db(DB_NAME) : c.db();
      // Idempotent indexes.
      await db.collection('vouchers').createIndex({ branch: 1, date: 1 });
      await db.collection('vouchers').createIndex({ branch: 1, guid: 1 }, { unique: true });
      await db.collection('masters').createIndex({ branch: 1 }, { unique: true });
      console.log(`Mongo connected: db="${DB_NAME}"`);
      return db;
    });
  }
  return dbPromise;
}

async function close() {
  if (client) await client.close();
}

module.exports = { getDb, close, DB_NAME };
