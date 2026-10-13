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
| GET | `/api/clients?branch=all\|kol\|ahm&measure=gross\|net\|netpl&fromFy=2020-21` | Every Sundry Debtor as one row: contacts off the master, sales per financial year and the first/last invoice date out of the `yoy_party` fold. One row per **client** (spellings merged), plus `filled` (a count per column), `traded` (rows with sales in the window) and `datesComplete` (`filled.lastSale >= traded`) so an unbuilt fold reads as early rather than broken. Backs `/diag/clients.html`. |
| GET | `/api/sales/monthly?branch=&measure=&fromFy=&section=sales\|purchase&min=0` | One row per customer, one column per **calendar month** (`YYYYMM`), flat and sparse — the same fold `/api/yoy/party` serves as a tree. Month 0 of a financial year is April, and the endpoint names the months so a caller never re-derives that. Reads the stored fold, not the vouchers. |
| GET | `/api/products?branch=&from=&to=&by=product\|hsn\|party&party=&limit=500&offset=0` | What was sold, by stock item, HSN, or **customer × item** (`by=party`, which adds `ledger` to each row), over a date window (default: the current FY, max 400 days) and optionally for one customer. Paged: `rows_total`, `offset`, `returned`, `truncated`, `nextOffset`. The **only** endpoint that reads raw vouchers — line items live in `details.items`, which `/api/dataset` projects away. Attributes each invoice with the fold's own dominant-Sundry-Debtor rule, takes the product from the FIRST line of Tally's description block, and sums quantities **per unit**. Reports why the rest did not count: `skipped.notASale` / `skipped.saleWithoutDebtor`, `byTypeNotCounted`, and `saleWithoutDebtorSample` (up to 20, with voucher type and number). |
| GET | `/health` | Liveness (checks Mongo connection). |
| GET | `/consolidated/`, `/projected/`, `/dashboard/` | The static dashboards. |

## Data model

- **`masters`** — one doc per branch: `{branch, ledgers, groups, contacts, updatedAt}` (latest snapshot wins). `contacts` is per ledger: `{name, email, mobile, phone, gstin, pan, address, state, country}` — the last four arrive from the pipeline's separate `LedgerDetail` request and are empty until a sync has run since v2.54.
- **`vouchers`** — one doc per voucher: `{_id, branch, guid, date, party, no, type, ledgers, party_ledgers, details?, bills?, cancelled?, optional?, updatedAt}`. `cancelled`/`optional` are Tally's own marks, written only when true and **unset** when Tally stops reporting them (an optional voucher confirmed later is an ordinary sale). Every figure excludes them — see `LIVE_ONLY` in `server.js`. `_id = branch:guid` (or `branch:date:type:no:hash` when no GUID). Indexed on `{branch, date}`.
  - `details` is **optional** and only present on vouchers that carry invoice/inventory extras (sales/purchase invoices etc.). It holds the data needed to reprint the voucher exactly like Tally: `{narration, reference, partyGstin, partyName, partyAddress[], partyState, placeOfSupply, consignee*, deliveryNote, despatchedThrough, destination, ewayBillNo, vehicleNo, termsOfPayment, buyersOrderNo, irn, ackNo, ackDate, items:[{slNo, description, hsn, qty, unit, rate, disc, amount}]}`. The write path (`cleanDetails` in `ingest.js`) whitelists these fields so a payload can't bloat the store. Bare journals/receipts carry no `details` key.

## Printable voucher / invoice

`/voucher/` renders a stored voucher as a Tally-style **Tax Invoice** or **Journal Voucher**. **Download PDF** generates a real `.pdf` file client-side (`html2canvas` + `jsPDF`, both vendored in `voucher/vendor/` — offline, no CDN); a separate **Print** button uses the browser's vector print path. Open it as:

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
