// Shared ingest logic: upsert a master snapshot + bulk-upsert vouchers for one branch.
// Used by both the HTTP /ingest route (server.js) and the file loader (loader.js),
// so the write path is identical however the data arrives.
const crypto = require('crypto');
const { getDb } = require('./db');

const VALID_BRANCHES = new Set(['kol', 'ahm']);

// Stable hash of a voucher's monetary lines. Used only when no Tally GUID is
// present, to keep the fallback key from collapsing two distinct vouchers that
// happen to share (date, type, no) - which real Tally data does (e.g. two
// different Purchase #1954 on the same day). Same content -> same key -> still
// idempotent across re-runs.
function contentHash(v) {
  const norm = (o) => Object.keys(o || {}).sort().map((k) => `${k}=${o[k]}`).join(',');
  return crypto.createHash('sha1').update(`${norm(v.ledgers)}|${norm(v.party_ledgers)}`).digest('hex').slice(0, 10);
}

// Keep only the dashboard-relevant voucher fields (+ guid for keying). Guards against
// arbitrary extra keys sneaking into the store.
function cleanVoucher(v) {
  return {
    date: String(v.date || ''),
    party: v.party || '',
    no: v.no != null ? String(v.no) : '',
    type: v.type || '',
    ledgers: v.ledgers && typeof v.ledgers === 'object' ? v.ledgers : {},
    party_ledgers: v.party_ledgers && typeof v.party_ledgers === 'object' ? v.party_ledgers : {},
  };
}

function voucherKey(branch, v) {
  if (v.guid) return `${branch}:${v.guid}`;
  return `${branch}:${v.date}:${v.type}:${v.no}:${contentHash(v)}`;
}

// payload = { branch, from, to, master:{ledgers,groups}, vouchers:[...] }
async function ingest(payload) {
  const branch = String(payload.branch || '').toLowerCase();
  if (!VALID_BRANCHES.has(branch)) {
    throw Object.assign(new Error(`invalid branch "${payload.branch}" (expected kol|ahm)`), { status: 400 });
  }
  const db = await getDb();
  const result = { branch, masterUpserted: false, vouchers: 0, dateRange: [payload.from || null, payload.to || null] };

  // 1) Master snapshot (latest wins per branch).
  if (payload.master && payload.master.ledgers && payload.master.groups) {
    await db.collection('masters').updateOne(
      { branch },
      { $set: { branch, ledgers: payload.master.ledgers, groups: payload.master.groups, updatedAt: new Date() } },
      { upsert: true }
    );
    result.masterUpserted = true;
  }

  // 2) Vouchers (idempotent upsert on branch+guid, so re-running a day is safe).
  const vouchers = Array.isArray(payload.vouchers) ? payload.vouchers : [];
  if (vouchers.length) {
    const ops = vouchers.map((raw) => {
      const v = cleanVoucher(raw);
      const _id = voucherKey(branch, raw);
      return {
        updateOne: {
          filter: { _id },
          update: { $set: { _id, branch, guid: raw.guid || _id, ...v, updatedAt: new Date() } },
          upsert: true,
        },
      };
    });
    // Chunk to keep bulk payloads reasonable.
    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const r = await db.collection('vouchers').bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      result.vouchers += (r.upsertedCount || 0) + (r.modifiedCount || 0) + (r.matchedCount || 0);
    }
  }
  return result;
}

// ---- ALTERID-based true-incremental sync ---------------------------------
// Tally stamps every voucher with a monotonic ALTERID that bumps on ANY create
// or edit, regardless of the voucher's date. So a lightweight metadata scan
// (guid + date + alterId for every voucher) tells us exactly what changed since
// last sync -- including backdated entries and edits -- and, by comparing the
// current guid set against what's in Mongo, what was deleted.

// Pure diff: given the full metadata list and the last synced alterId, return
// the dates that need a full re-pull, the complete current guid set (for
// deletion reconcile), and the new high-water alterId.
function diffMeta(meta, lastAlterId) {
  const last = Number(lastAlterId) || 0;
  const changedDates = new Set();
  const currentGuids = [];
  let maxAlter = last;
  for (const m of meta || []) {
    const a = Number(m.alterId) || 0;
    if (m.guid) currentGuids.push(String(m.guid));
    if (a > maxAlter) maxAlter = a;
    if (a > last && m.date) changedDates.add(String(m.date));
  }
  return { changedDates: Array.from(changedDates).sort(), currentGuids, newMaxAlterId: maxAlter };
}

async function getSyncState(branch) {
  branch = String(branch || '').toLowerCase();
  const db = await getDb();
  const s = await db.collection('sync_state').findOne({ branch });
  return { branch, lastAlterId: s ? Number(s.lastAlterId) || 0 : 0, updatedAt: s ? s.updatedAt : null };
}

// payload = { branch, lastAlterId, changedDates:[...], vouchers:[...for those dates...],
//             master?, currentGuids:[...all current...], reconcile?:bool }
async function syncIncremental(payload) {
  const branch = String(payload.branch || '').toLowerCase();
  if (!VALID_BRANCHES.has(branch)) {
    throw Object.assign(new Error(`invalid branch "${payload.branch}" (expected kol|ahm)`), { status: 400 });
  }
  const db = await getDb();
  const result = { branch, masterUpserted: false, replacedDates: 0, upserted: 0, deletedByDate: 0, deletedMissing: 0, lastAlterId: null };

  if (payload.master && payload.master.ledgers && payload.master.groups) {
    await db.collection('masters').updateOne(
      { branch },
      { $set: { branch, ledgers: payload.master.ledgers, groups: payload.master.groups, updatedAt: new Date() } },
      { upsert: true }
    );
    result.masterUpserted = true;
  }

  // 1) Replace every changed date wholesale: delete then insert the fresh pull.
  //    This captures edits, backdated new entries, and same-date deletions.
  const changedDates = Array.isArray(payload.changedDates) ? payload.changedDates.map(String) : [];
  if (changedDates.length) {
    const del = await db.collection('vouchers').deleteMany({ branch, date: { $in: changedDates } });
    result.deletedByDate = del.deletedCount;
    result.replacedDates = changedDates.length;
  }
  const vouchers = Array.isArray(payload.vouchers) ? payload.vouchers : [];
  if (vouchers.length) {
    const ops = vouchers.map((raw) => {
      const v = cleanVoucher(raw);
      const _id = voucherKey(branch, raw);
      return { updateOne: { filter: { _id }, update: { $set: { _id, branch, guid: raw.guid || _id, ...v, updatedAt: new Date() } }, upsert: true } };
    });
    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const r = await db.collection('vouchers').bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      result.upserted += (r.upsertedCount || 0) + (r.modifiedCount || 0) + (r.matchedCount || 0);
    }
  }

  // 2) Deletion reconcile: drop any Mongo voucher whose guid is no longer in
  //    Tally's current set. Guarded so a missing/empty list can never wipe data.
  if (payload.reconcile && Array.isArray(payload.currentGuids) && payload.currentGuids.length) {
    const keep = payload.currentGuids.map(String);
    const del2 = await db.collection('vouchers').deleteMany({ branch, guid: { $nin: keep } });
    result.deletedMissing = del2.deletedCount;
  }

  // 3) Advance the high-water mark.
  if (payload.lastAlterId != null) {
    await db.collection('sync_state').updateOne(
      { branch },
      { $set: { branch, lastAlterId: Number(payload.lastAlterId), updatedAt: new Date() } },
      { upsert: true }
    );
    result.lastAlterId = Number(payload.lastAlterId);
  }
  return result;
}

module.exports = { ingest, VALID_BRANCHES, cleanVoucher, voucherKey, diffMeta, getSyncState, syncIncremental };
