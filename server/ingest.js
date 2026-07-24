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

// Whitelist of scalar detail fields carried through to Mongo for the printable
// voucher/invoice view. Anything outside this list (and `items`, handled below)
// is dropped so a rogue payload can't bloat the store.
const DETAIL_SCALARS = [
  'narration', 'reference', 'refDate',
  'partyGstin', 'partyName', 'partyMailName', 'partyState', 'placeOfSupply',
  'contactName', 'contactEmail', 'contactMobile',
  'consigneeName', 'consigneeGstin', 'consigneeState',
  'deliveryNote', 'deliveryNoteDate', 'despatchDocNo', 'despatchedThrough',
  'destination', 'ewayBillNo', 'vehicleNo', 'termsOfPayment', 'termsOfDelivery',
  'billOfLading', 'billOfLadingDate', 'otherReference',
  'buyersOrderNo', 'buyersOrderDate', 'irn', 'ackNo', 'ackDate',
];
const ITEM_FIELDS = ['slNo', 'description', 'hsn', 'qty', 'unit', 'rate', 'disc', 'amount'];

// Party contact map from the Ledger master: { ledgerName: { name, email, mobile } }.
// Kept small and string-only so a master push can't smuggle arbitrary structure in.
function cleanContacts(c) {
  if (!c || typeof c !== 'object') return undefined;
  const out = {};
  for (const [ledger, v] of Object.entries(c)) {
    if (!v || typeof v !== 'object') continue;
    const row = {};
    for (const f of ['name', 'email', 'mobile']) {
      if (v[f] != null && v[f] !== '') row[f] = String(v[f]);
    }
    if (Object.keys(row).length) out[String(ledger)] = row;
  }
  return Object.keys(out).length ? out : undefined;
}

// Normalise the extractor's `details` object into a compact, known shape. Returns
// undefined when there's nothing worth storing (bare vouchers stay lean).
function cleanDetails(d) {
  if (!d || typeof d !== 'object') return undefined;
  const out = {};
  for (const k of DETAIL_SCALARS) {
    if (d[k] != null && d[k] !== '') out[k] = String(d[k]);
  }
  const addrLines = (a) => (Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean).slice(0, 10) : []);
  const pa = addrLines(d.partyAddress);
  const ca = addrLines(d.consigneeAddr || d.consigneeAddress);
  if (pa.length) out.partyAddress = pa;
  if (ca.length) out.consigneeAddr = ca;
  if (Array.isArray(d.items) && d.items.length) {
    out.items = d.items.map((it) => {
      const row = {};
      for (const f of ITEM_FIELDS) {
        if (it[f] == null) continue;
        row[f] = f === 'amount' ? Number(it[f]) || 0 : String(it[f]);
      }
      return row;
    });
  }
  return Object.keys(out).length ? out : undefined;
}

// Keep only the dashboard-relevant voucher fields (+ guid for keying). Guards against
// arbitrary extra keys sneaking into the store. `details` (invoice/inventory extras)
// is optional and only stored when present.
function cleanVoucher(v) {
  const out = {
    date: String(v.date || ''),
    party: v.party || '',
    no: v.no != null ? String(v.no) : '',
    type: v.type || '',
    ledgers: v.ledgers && typeof v.ledgers === 'object' ? v.ledgers : {},
    party_ledgers: v.party_ledgers && typeof v.party_ledgers === 'object' ? v.party_ledgers : {},
  };
  const details = cleanDetails(v.details);
  if (details) out.details = details;
  return out;
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
    const set = { branch, ledgers: payload.master.ledgers, groups: payload.master.groups, updatedAt: new Date() };
    const contacts = cleanContacts(payload.master.contacts);
    if (contacts) set.contacts = contacts;
    await db.collection('masters').updateOne({ branch }, { $set: set }, { upsert: true });
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
    const set = { branch, ledgers: payload.master.ledgers, groups: payload.master.groups, updatedAt: new Date() };
    const contacts = cleanContacts(payload.master.contacts);
    if (contacts) set.contacts = contacts;
    await db.collection('masters').updateOne({ branch }, { $set: set }, { upsert: true });
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
  //    Tally's current set. Guarded so a missing/empty list can never wipe data,
  //    and SCOPED to the date window the scan actually observed -- so if Tally's
  //    active period ever narrows (e.g. back to the current FY only), we never
  //    delete history that simply wasn't in this scan.
  if (payload.reconcile && Array.isArray(payload.currentGuids) && payload.currentGuids.length) {
    const keep = payload.currentGuids.map(String);
    const q = { branch, guid: { $nin: keep } };
    if (payload.scanFrom && payload.scanTo) q.date = { $gte: String(payload.scanFrom), $lte: String(payload.scanTo) };
    const del2 = await db.collection('vouchers').deleteMany(q);
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

module.exports = { ingest, VALID_BRANCHES, cleanVoucher, cleanDetails, cleanContacts, voucherKey, diffMeta, getSyncState, syncIncremental };
