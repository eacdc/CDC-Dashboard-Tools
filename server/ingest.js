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
    // gstin is the party's identity, not just a contact detail: it is what lets a
    // renamed ledger be recognised across financial years (see aliasSuggest.js).
    for (const f of ['name', 'email', 'mobile', 'gstin']) {
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
  // PowerShell's ConvertTo-Json UNWRAPS a single-element array into a bare
  // object/scalar, so a voucher with exactly one item (or one address line) arrives
  // as {..}/"str" instead of [..]. Coerce back to an array so it isn't dropped.
  const asArr = (x) => (Array.isArray(x) ? x : (x == null || x === '' ? [] : [x]));
  const addrLines = (a) => asArr(a).map((x) => String(x)).filter(Boolean).slice(0, 10);
  const pa = addrLines(d.partyAddress);
  const ca = addrLines(d.consigneeAddr || d.consigneeAddress);
  if (pa.length) out.partyAddress = pa;
  if (ca.length) out.consigneeAddr = ca;
  const items = asArr(d.items).filter((it) => it && typeof it === 'object');
  if (items.length) {
    out.items = items.map((it) => {
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
  // Bill-wise allocations (bill reference each posting is booked against). Optional;
  // only present on vouchers that carry BILLALLOCATIONS in Tally. Powers the portal's
  // true bill-wise receipt matching (settle the exact bill, not oldest-first FIFO).
  if (Array.isArray(v.bills) && v.bills.length) {
    const bills = v.bills
      .map((b) => ({
        ledger: String((b && b.ledger) || ''),
        ref: String((b && b.ref) || ''),
        type: String((b && b.type) || ''),
        amount: Number(b && b.amount) || 0,
      }))
      .filter((b) => b.ref && b.ledger);
    if (bills.length) out.bills = bills;
  }
  return out;
}

function voucherKey(branch, v) {
  if (v.guid) return `${branch}:${v.guid}`;
  return `${branch}:${v.date}:${v.type}:${v.no}:${contentHash(v)}`;
}

// Union two name->value maps, with `base` winning every collision.
function unionMaps(base, extra) {
  const out = {};
  for (const [k, v] of Object.entries(extra || {})) out[k] = v;
  for (const [k, v] of Object.entries(base || {})) out[k] = v;
  return out;
}

// Build the $set for the masters collection.
//
// mode 'replace' (default) is the normal live sync: `ledgers`/`groups`/`contacts`/
// `ids` are the snapshot of Tally as it stands right now, latest wins.
//
// mode 'merge' is a historical back-fill from an OLD financial-year company. Its
// ledger list is Tally as it stood back then, so it must never land in the live
// fields — a party opened since would vanish and every voucher of theirs would
// stop classifying as debtor/creditor. Instead the old-only names accumulate in
// SEPARATE `histLedgers`/`histGroups`/`histContacts` fields, which the live sync
// never writes. Reads union the two with the live side winning (see readMaster),
// so back-filled ledgers survive every future daily sync — a plain merge into the
// live fields would be wiped by the very next one.
//
// `ids` (ledger name -> Tally GUID) is never taken from a historical pull: GUIDs
// are per company, so an old company's GUID is meaningless against the current one.
async function masterSet(db, branch, master, mode) {
  const updatedAt = new Date();
  if (mode === 'merge') {
    const cur = (await db.collection('masters').findOne({ branch })) || {};
    const set = { branch, updatedAt };
    // Keep only what the live master doesn't already define, so the historical
    // fields stay small and can never shadow a current mapping even by accident.
    // hasOwnProperty, not truthiness: a root group's parent is legitimately null,
    // and those keys ARE defined by the live master.
    const onlyNew = (incoming, live) => {
      const out = {};
      const have = live || {};
      for (const [k, v] of Object.entries(incoming || {})) {
        if (!Object.prototype.hasOwnProperty.call(have, k)) out[k] = v;
      }
      return out;
    };
    set.histLedgers = unionMaps(cur.histLedgers, onlyNew(master.ledgers, cur.ledgers));
    set.histGroups = unionMaps(cur.histGroups, onlyNew(master.groups, cur.groups));
    const hc = onlyNew(cleanContacts(master.contacts), cur.contacts);
    const mergedContacts = unionMaps(cur.histContacts, hc);
    if (Object.keys(mergedContacts).length) set.histContacts = mergedContacts;
    return set;
  }
  const set = { branch, ledgers: master.ledgers, groups: master.groups, updatedAt };
  const contacts = cleanContacts(master.contacts);
  if (contacts) set.contacts = contacts;
  // Ledger GUIDs (name -> stable Tally id) so the dashboard can merge renamed parties.
  if (master.ids && typeof master.ids === 'object') set.ids = master.ids;
  // What each party owes, in Tally's own words, and the day it was struck on. The
  // vouchers can only ever show movement since the oldest one we hold, so a customer
  // who already owed money before that cannot be got right by adding vouchers up.
  // Stored only on a 'replace' (live) pull: a back-fill of an old year carries that
  // year's balances, which would quietly replace the current ones.
  if (master.closing && typeof master.closing === 'object') {
    set.closing = master.closing;
    set.closingAsOn = master.closingAsOn || null;
  }
  if (master.opening && typeof master.opening === 'object') {
    set.opening = master.opening;
    set.openingAsOn = master.openingAsOn || null;
  }
  return set;
}

// The hierarchy as the dashboards should see it: the live Tally master, plus any
// back-filled ledgers/groups that only ever existed in an older financial year.
// Live always wins. Returns null when the branch has no master at all.
function readMaster(doc) {
  if (!doc) return null;
  return {
    ledgers: unionMaps(doc.ledgers, doc.histLedgers),
    groups: unionMaps(doc.groups, doc.histGroups),
    contacts: unionMaps(doc.contacts, doc.histContacts),
    ids: doc.ids || {},
    closing: doc.closing || null,
    closingAsOn: doc.closingAsOn || null,
    opening: doc.opening || null,
    openingAsOn: doc.openingAsOn || null,
    updatedAt: doc.updatedAt || null,
  };
}

// payload = { branch, from, to, master:{ledgers,groups}, vouchers:[...],
//             masterMode?: 'replace'|'merge' }
async function ingest(payload) {
  const branch = String(payload.branch || '').toLowerCase();
  if (!VALID_BRANCHES.has(branch)) {
    throw Object.assign(new Error(`invalid branch "${payload.branch}" (expected kol|ahm)`), { status: 400 });
  }
  const db = await getDb();
  const result = { branch, masterUpserted: false, vouchers: 0, dateRange: [payload.from || null, payload.to || null] };

  // 1) Master snapshot. 'replace' (default) = latest wins per branch, the normal
  //    live sync. 'merge' = historical back-fill: keep the live hierarchy, only add
  //    ledgers/groups that Tally no longer has (see mergeMasterMaps).
  const masterMode = payload.masterMode === 'merge' ? 'merge' : 'replace';
  result.masterMode = masterMode;
  if (payload.master && payload.master.ledgers && payload.master.groups) {
    const set = await masterSet(db, branch, payload.master, masterMode);
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
      // upserted + matched, NOT + modified: an existing voucher that changes is
      // reported as BOTH matched and modified, so adding all three counted every
      // re-sync twice and reported 2000 vouchers stored for a 1000-voucher push.
      result.vouchers += (r.upsertedCount || 0) + (r.matchedCount || 0);
    }
  }
  return result;
}

// Wipe a branch before a clean re-ingest.
//
// Needed when the WRONG Tally company was pulled into a branch (an -Branch/-Company
// mismatch). Those vouchers carry the other company's GUIDs, so `branch:guid` never
// collides with the right ones: an ordinary re-push does not overwrite them, it just
// leaves BOTH companies sitting in the branch, and every figure is the sum of two
// companies. Only a delete gets rid of them.
//
// The master goes too by default, because the bad push also REPLACED the branch's
// ledger hierarchy with the other company's, and any histLedgers left by a back-fill
// would keep those names alive even after a correct re-push (readMaster unions them).
// The very next push carries a fresh master, so the branch is rebuilt in one step.
//
// sync_state goes too: it is the ALTERID high-water mark, and an ID from the wrong
// company means nothing against the right one. Cleared, the next incremental sync
// re-scans everything instead of trusting a mark it cannot interpret.
//
// Scope is explicit, never guessed: {from,to} deletes just that date range (what the
// re-pull is about to replace), all:true deletes every voucher of the branch. Without
// one of the two this throws rather than defaulting to "delete everything".
async function resetBranch(payload) {
  const branch = String(payload.branch || '').toLowerCase();
  if (!VALID_BRANCHES.has(branch)) {
    throw Object.assign(new Error(`invalid branch "${payload.branch}" (expected kol|ahm)`), { status: 400 });
  }
  const all = payload.all === true || payload.all === 'true';
  const from = payload.from == null ? null : String(payload.from);
  const to = payload.to == null ? null : String(payload.to);
  const isYmd = (s) => typeof s === 'string' && /^\d{8}$/.test(s);
  if (!all && !(isYmd(from) && isYmd(to))) {
    throw Object.assign(new Error('reset needs from+to as YYYYMMDD, or all:true'), { status: 400 });
  }
  const db = await getDb();
  const q = all ? { branch } : { branch, date: { $gte: from, $lte: to } };
  const del = await db.collection('vouchers').deleteMany(q);
  const result = {
    branch,
    scope: all ? 'all dates' : `${from}..${to}`,
    deletedVouchers: del.deletedCount || 0,
    masterDeleted: false,
    syncStateCleared: false,
  };
  if (payload.master !== false) {
    result.masterDeleted = ((await db.collection('masters').deleteOne({ branch })).deletedCount || 0) > 0;
  }
  if (payload.syncState !== false) {
    result.syncStateCleared = ((await db.collection('sync_state').deleteOne({ branch })).deletedCount || 0) > 0;
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

  // Incremental only ever runs against the live company, so the master always replaces.
  if (payload.master && payload.master.ledgers && payload.master.groups) {
    const set = await masterSet(db, branch, payload.master, 'replace');
    await db.collection('masters').updateOne({ branch }, { $set: set }, { upsert: true });
    result.masterUpserted = true;
  }

  // 1) Replace every changed date wholesale: delete then insert the fresh pull.
  //    This captures edits, backdated new entries, and same-date deletions.
  //
  //    But ONLY for dates the pull actually brought vouchers for. A date flagged as
  //    changed whose replacement is empty is the shape of a failed pull, not of an
  //    emptied day -- and that is exactly how a week of May 2026 disappeared: the
  //    extractor was talking to a Tally that did not have the company loaded, so the
  //    days were deleted and nothing came back to replace them.
  //
  //    A day whose vouchers really were all deleted in Tally is still cleaned up:
  //    the reconcile below removes anything whose guid Tally no longer lists.
  const vouchers = Array.isArray(payload.vouchers) ? payload.vouchers : [];
  const changedDates = Array.isArray(payload.changedDates) ? payload.changedDates.map(String) : [];
  if (changedDates.length) {
    const haveFor = new Set(vouchers.map((v) => String((v && v.date) || '')));
    const replace = changedDates.filter((d) => haveFor.has(d));
    const skipped = changedDates.filter((d) => !haveFor.has(d));
    if (replace.length) {
      const del = await db.collection('vouchers').deleteMany({ branch, date: { $in: replace } });
      result.deletedByDate = del.deletedCount;
    }
    result.replacedDates = replace.length;
    if (skipped.length) {
      // Only worth reporting when we actually hold something for those dates --
      // otherwise it is just a day with no entries, which is unremarkable.
      const held = await db.collection('vouchers').countDocuments({ branch, date: { $in: skipped } });
      result.skippedEmptyDates = skipped.length;
      result.skippedEmptyHeld = held;
      if (held > 0) {
        result.warning = `${skipped.length} changed date(s) came back empty while ${held} voucher(s) are stored for them; left untouched. Check the extractor reached the right Tally.`;
        console.warn(`[sync ${branch}] ${result.warning} dates: ${skipped.slice(0, 10).join(',')}`);
      }
    }
  }
  if (vouchers.length) {
    const ops = vouchers.map((raw) => {
      const v = cleanVoucher(raw);
      const _id = voucherKey(branch, raw);
      return { updateOne: { filter: { _id }, update: { $set: { _id, branch, guid: raw.guid || _id, ...v, updatedAt: new Date() } }, upsert: true } };
    });
    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const r = await db.collection('vouchers').bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      // See ingest(): matched and modified overlap, so adding both double-counts.
      result.upserted += (r.upsertedCount || 0) + (r.matchedCount || 0);
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
    const window = {};
    if (payload.scanFrom && payload.scanTo) {
      window.date = { $gte: String(payload.scanFrom), $lte: String(payload.scanTo) };
      q.date = window.date;
    }
    // Does this list even belong to this branch? A non-empty list was the only
    // check, and a list from the WRONG COMPANY passes that easily -- every guid is
    // foreign, so "delete everything Tally no longer lists" means delete the lot.
    // A healthy scan overlaps almost completely with what is stored; anything that
    // would clear more than half the window is refused for a person to look at.
    const held = await db.collection('vouchers').countDocuments(Object.assign({ branch }, window));
    const recognised = held ? await db.collection('vouchers').countDocuments(
      Object.assign({ branch, guid: { $in: keep } }, window)) : 0;
    const overlap = held ? recognised / held : 1;
    if (held >= 50 && overlap < 0.5) {
      result.deletedMissing = 0;
      result.reconcileRefused = true;
      result.warning = `reconcile refused: Tally's list matches only ${Math.round(overlap * 100)}% of the ${held} stored voucher(s) in this window, so it is probably not this branch's company. Nothing deleted.`;
      console.warn(`[sync ${branch}] ${result.warning}`);
    } else {
      const del2 = await db.collection('vouchers').deleteMany(q);
      result.deletedMissing = del2.deletedCount;
    }
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

module.exports = { ingest, resetBranch, VALID_BRANCHES, cleanVoucher, cleanDetails, cleanContacts, readMaster, voucherKey, diffMeta, getSyncState, syncIncremental };
