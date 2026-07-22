# CDC Dashboard API

Small Express + MongoDB service that backs the automated (MongoDB) mode of the
CDC dashboards. It owns all database writes and serves the dashboards' data by
date range. It can also serve the static dashboards, so the whole thing runs as
one service.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/ingest` | Upsert a branch's master snapshot + vouchers. Body: `{branch, from, to, master, vouchers}`. Requires `x-ingest-token` header if `INGEST_TOKEN` is set. Idempotent (upsert on branch+guid). |
| GET | `/api/dataset?from=YYYYMMDD&to=YYYYMMDD&branch=all\|kol\|ahm` | Per-branch `{hierarchy, vouchers}` for the range. Defaults: `from`=1-Apr of current FY, `to`=today, `branch`=all. Excludes `details` (kept lean for the dashboards). |
| GET | `/api/voucher?branch=kol\|ahm&id=<guid>` (or `&no=<vchNo>[&type=&date=]`) | One voucher with **full `details`** (party GSTIN/address, invoice metadata, e-way bill, narration, HSN/qty/rate line items). Backs the printable invoice/journal view at `/voucher/`. |
| GET | `/api/meta` | Per-branch voucher count + date coverage + master timestamp. |
| GET | `/health` | Liveness (checks Mongo connection). |
| GET | `/consolidated/`, `/projected/`, `/dashboard/` | The static dashboards. |

## Data model

- **`masters`** — one doc per branch: `{branch, ledgers, groups, updatedAt}` (latest snapshot wins).
- **`vouchers`** — one doc per voucher: `{_id, branch, guid, date, party, no, type, ledgers, party_ledgers, details?, updatedAt}`. `_id = branch:guid` (or `branch:date:type:no:hash` when no GUID). Indexed on `{branch, date}`.
  - `details` is **optional** and only present on vouchers that carry invoice/inventory extras (sales/purchase invoices etc.). It holds the data needed to reprint the voucher exactly like Tally: `{narration, reference, partyGstin, partyName, partyAddress[], partyState, placeOfSupply, consignee*, deliveryNote, despatchedThrough, destination, ewayBillNo, vehicleNo, termsOfPayment, buyersOrderNo, irn, ackNo, ackDate, items:[{slNo, description, hsn, qty, unit, rate, disc, amount}]}`. The write path (`cleanDetails` in `ingest.js`) whitelists these fields so a payload can't bloat the store. Bare journals/receipts carry no `details` key.

## Printable voucher / invoice

`/voucher/` renders a stored voucher as a Tally-style **Tax Invoice** or **Journal Voucher** and offers a **Download PDF** button (browser print-to-PDF — no external libraries, so it works offline and inside the artifact CSP). Open it as:

```
/voucher/?branch=kol&id=<guid>          # by GUID / _id
/voucher/?branch=ahm&no=CDC/2662/26-27  # by voucher number
/voucher/?demo=invoice   /voucher/?demo=journal   # bundled samples, no DB needed
```

The tax summary (HSN-wise CGST/SGST/IGST) is computed client-side from the line items and the GST ledger legs, so it stays correct even though Tally's Day Book export doesn't emit a per-HSN breakup.

## Local run

```bash
cd server
cp .env.example .env      # fill in MONGODB_URI (Atlas), INGEST_TOKEN
npm install
npm start                 # http://localhost:3000
```

Then load data (from the .ps1 output folder):

```bash
MONGODB_URI="mongodb+srv://..." node loader.js --dir ../tally_export --branch ahm
```

Open http://localhost:3000/consolidated/ and pick **MongoDB (auto)** (API base can
stay blank — same origin).

## Deploy (Render)

`render.yaml` at the repo root defines the service (`rootDir: server`). Set
`MONGODB_URI` and `INGEST_TOKEN` as secret env vars in the Render dashboard.
Point the `.ps1` `-IngestUrl` at the resulting URL.

## Tests

```bash
npm run test:logic     # no DB needed — stubs the driver, ingests the real amd sample, checks idempotency/filtering
MONGODB_URI="..." npm run test:db      # against a real cluster (uses a throwaway db, then drops it)
npm run test:browser   # drives the actual dashboards in Chromium through the Mongo flow
```

`test:db` and `test:browser` need the sample files passed as args, e.g.
`node test_e2e_fake.js path/to/amd_Master.json path/to/amd_Transactions.json`.
