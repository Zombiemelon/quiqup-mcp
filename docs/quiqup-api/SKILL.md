---
name: quiqup-api
description: This skill should be used when the user asks to "call the Quiqup API", "hit platform-api.quiqup.com", "hit api.quiqup.com", "get a Quiqup access token", "list Quiqup inventory", "create a fulfilment order", "adjust stock", "check an inbound delivery", "book an inbound slot", "get/update a Quiqup product by SKU", "bulk upload products", "create a last-mile order", "mark order ready for collection", "cancel a Quiqup order", "get an AWB label", "download a parcel label", or any other interaction with Quiqup's two public APIs (Fulfilment + Last-Mile) from the CLI.
---

# Quiqup API CLI (Fulfilment + Last-Mile)

Use this skill to interact with Quiqup's two public APIs from the terminal:

- **Fulfilment API** (`platform-api.quiqup.com`) — warehousing, inventory, inbound, products, fulfilment orders.
- **Last-Mile API** (`api.quiqup.com`) — courier/delivery orders, AWB labels, cancellations, parcel management.

Select the API with `--api fulfilment` (default) or `--api lastmile`. Token management, per-env routing, OAuth flow shape (JSON body vs query params), and guardrails are handled by the bundled `scripts/quiqup.sh` wrapper so individual calls stay one-liners.

## When to use

Invoke when the user wants to:
- Fetch, adjust, or inspect inventory (SKU or batch level)
- Create, read, or update fulfilment orders
- Book inbound deliveries or query their state history
- Create / update / bulk-upload products
- Obtain or refresh an OAuth2 access token for ad-hoc debugging

For any question that is strictly about API semantics (what a field means, what a response looks like), read `references/endpoints.md` or the mirrored docs at `wiki/quiqup/knowledge_base/quiqup_api_docs/` instead of hitting the network.

## Setup — credentials

The wrapper loads credentials in this order (later sources override earlier):

1. Repo-root `.env` (walked upward from the current directory)
2. Skill-local `.claude/skills/quiqup-api/.env`

Either location works. The skill ships with a template at `.claude/skills/quiqup-api/.env.example` — copy it to `.env` in the same folder and fill in values:

```bash
cp .claude/skills/quiqup-api/.env.example .claude/skills/quiqup-api/.env
```

Required variables:

```
QUIQUP_CLIENT_ID=...            # staging client_id
QUIQUP_CLIENT_SECRET=...        # staging client_secret
QUIQUP_PROD_CLIENT_ID=...       # production (only for --env prod)
QUIQUP_PROD_CLIENT_SECRET=...   # production (only for --env prod)
```

Both `.env` locations are gitignored (repo `.gitignore` matches `.env` at any depth). Never commit real credentials. If credentials are missing, the wrapper exits with a clear error pointing to the missing variables — ask the user for them rather than inventing values.

### Creating new OAuth2 clients (per merchant)

OAuth2 `client_id` / `client_secret` pairs are created in the Quiqup admin UI at **https://qadmin.quiqup.com/oauth/clients**. Each merchant gets their own client — the client is partner-scoped, so writes against another merchant's orders will fail (see "Auth scope reality check" below). When doing cross-merchant work (support backfills etc.), create a client for that specific merchant and add its credentials to `.env` as new variables (e.g. `AMARA_CLIENT_ID` / `AMARA_CLIENT_SECRET`), then override the default by exporting them before invoking `scripts/quiqup.sh`:

```bash
# one-shot override for a single merchant
QUIQUP_PROD_CLIENT_ID="$AMARA_CLIENT_ID" \
QUIQUP_PROD_CLIENT_SECRET="$AMARA_CLIENT_SECRET" \
  .claude/skills/quiqup-api/scripts/quiqup.sh --api fulfilment PATCH /api/fulfilment/orders/25095757 -d @payload.json --i-confirmed
```

Or just curl directly against `/oauth/token` → `/api/fulfilment/...` with the specific merchant's credentials for ad-hoc work. OAuth2 tokens are long-lived (1h) — unlike Clerk UI sessions — so one token covers a whole batch.

## Pre-flight — MANDATORY first step

**Before the first API call of a session, ask the user via `AskUserQuestion`** which environment and which API to target. Do NOT assume from context — endpoints, IDs, and data differ between staging/prod and fulfilment/last-mile. Skip only when the user has already stated both explicitly in their request (e.g., "hit last-mile prod for order X").

Ask two questions (one tool call, two `questions[]` entries):

1. **Environment** — options: `Production` (live data, real merchants), `Staging` (sandbox).
2. **API** — options: `Last-Mile` (courier/delivery orders, `api-ae.quiqup.com`), `Fulfilment` (warehousing/inventory/orders, `platform-api.quiqup.com`).

Cache the answers for the rest of the session; re-ask only if the user explicitly switches context. After the first call succeeds, subsequent related calls reuse the same `--api` and `--env` without re-prompting.

## Core workflow

Invoke the wrapper instead of hand-rolling `curl`:

```bash
.claude/skills/quiqup-api/scripts/quiqup.sh [--env staging|prod] [--raw] METHOD PATH [curl-args...]
.claude/skills/quiqup-api/scripts/quiqup.sh token [--env staging|prod] [--refresh]
```

- **Default env is `prod`.** Pass `--env staging` when the user wants the sandbox. Note: because prod is the default, even a bare mutation call (`PATCH`/`POST`/`DELETE`) is treated as a dangerous-prod operation by the guardrail and requires explicit per-call confirmation.
- Tokens are cached at `$TMPDIR/quiqup_token_{env}.json` with the real `expires_at` so repeated calls reuse them.
- Force-refresh with `--refresh` when a 401 response suggests staleness.
- Output is pretty-printed JSON by default. Use `--raw` when piping to `jq` or other consumers.

## Quick reference

```bash
SCRIPT=.claude/skills/quiqup-api/scripts/quiqup.sh

# Auth
$SCRIPT token                                    # print access token (cached)
$SCRIPT token --refresh                          # force a new token

# Inventory
$SCRIPT GET /api/fulfilment/inventory
$SCRIPT GET /api/fulfilment/inventory/SKU123
$SCRIPT GET /api/fulfilment/inventory/SKU123/batches
$SCRIPT GET /api/fulfilment/batches/BATCH_ID
$SCRIPT POST /api/fulfilment/inventory/adjustments \
  -d '{"sku":"SKU123","delta":5,"reason":"recount"}'

# Inbound
$SCRIPT GET "/api/fulfilment/slots/available?date=2026-04-20"
$SCRIPT POST /api/fulfilment/inbound/book \
  -d '{"slot_id":"SLOT_ABC","items":[{"sku":"SKU123","quantity":10}]}'
$SCRIPT GET /api/fulfilment/inbounds
$SCRIPT GET /api/fulfilment/inbound/INB_ID
$SCRIPT GET /api/fulfilment/inbound/INB_ID/state-history

# Orders
$SCRIPT POST /api/fulfilment/orders -d @order.json
$SCRIPT GET /api/fulfilment/orders/ORDER_ID
$SCRIPT PATCH /api/fulfilment/orders/ORDER_ID -d '{"status":"cancelled"}'

# Products
$SCRIPT POST /api/fulfilment/products -d @product.json
$SCRIPT GET /api/fulfilment/products/SKU123
$SCRIPT PATCH /api/fulfilment/products/SKU123 -d '{"name":"New name"}'
$SCRIPT POST /api/fulfilment/products/bulk/validate -F "file=@upload.csv"
$SCRIPT POST /api/fulfilment/products/bulk/commit -d '{"upload_id":"UPL_ABC"}'
```

## Bulk operations — `scripts/wms_resync.py`

For bulk status checks or the WMS re-sync trick (§1 of `fulfilment_workarounds.md`), use the parallelized Python helper — much faster than looping `quiqup.sh`. Status check on 10 orders: ~1.5s. Full re-sync on 80: ~25s.

```bash
PY=.claude/skills/quiqup-api/scripts/wms_resync.py

# Partner creds — pass as flags, or export once:
export QUIQUP_PARTNER_CLIENT_ID="d7ht...apps.quiqup.com"
export QUIQUP_PARTNER_CLIENT_SECRET="c459..."

# GET-only status (no side-effects). Reads IDs from argv OR stdin.
$PY --check 25081880 25081885 25081889
cat ids.txt | $PY --check

# Full re-sync: GET -> PUT unchanged payload -> GET -> verify.
# Fires the Anchanto Order Created audit chain on each order.
$PY --resync 25081880 25081885 25081889
$PY --resync --workers 12 $(cat ids.txt)

# Override creds per merchant (e.g. Amara Crown)
$PY --client-id "$AMARA_CLIENT_ID" --client-secret "$AMARA_CLIENT_SECRET" --resync <IDs>
```

Verdict column on `--resync`:

| Verdict | Meaning |
|---|---|
| `OK` | PUT 200, `updated_at` refreshed, `picking_order_created: true` |
| `NO_CHANGE` | PUT 200 but server dedup'd payload (common on `cancelled`) |
| `NOT_PICKING` | PUT 200 but Anchanto never accepted → data still broken |
| `PUT_FAIL` | Non-200 or network timeout → retry usually works |
| `SKIP_NO_PHONE` | Both contact phones empty → payload can't build; escalate to merchant |

The script's `build_export_payload()` is byte-preserving (no fixes applied). When you need to ALSO correct origin city / blank SKU / phones, use the client-specific fixer instead (e.g. `wiki/quiqup/client_resolutions/amara_crown/fix_origin_city.py`).

**Important:** the PUT is idempotent at the server. An unchanged payload fires the audit chain the first time (because something about the stored state changes), but repeat PUTs with the same bytes come back `NO_CHANGE` — the server dedups. If a re-sync returns all `NO_CHANGE` and the orders still don't move, the blocker is no longer WMS ingestion — it's downstream. Use the BQ check below to triage.

**Caveat — when `wms_resync.py` PUT does NOT trigger Anchanto.** Re-syncs return 200 and fire `order_updated`, but the connector silently skips `anchanto_order_created` for "non-material" updates (carrier, incoterms, byte-preserving). If Anchanto is holding a stale/cancelled record, the warehouse won't ship it. Verify by checking the audit log (`https://audit.quiqup.com/events?resourceID.eq={uuid}`) — if there's no fresh `.anchanto_order_created` event after your PUT, use the qty-toggle below.

### Carrier / incoterm only — use the shipment endpoint, not export PUT

When the ONLY fields you want to change are `carrier` + `incoterm`, the export PUT path is the wrong tool — it sends a full order payload, may or may not trigger Anchanto, and risks duplicate records. The dedicated **shipment-layer** endpoint at `PUT /shipments/{uuid}/update-carrier-details` does exactly this in one call with no Anchanto side-effects. Auth is the same OAuth2 client_credentials. Helper script:

```bash
.claude/skills/quiqup-api/scripts/update_carrier_incoterm.py \
  --carrier ARAMEX --incoterm DDU \
  --order-ids 25082072 25082075 25082082 25082094 25082109
```

Full reference (endpoint, body shape, BQ shipment_id lookup, verification): **`references/shipment_carrier_update.md`**.

### Force Anchanto retrigger — `scripts/qty_toggle_anchanto.py`

```bash
.claude/skills/quiqup-api/scripts/qty_toggle_anchanto.py 25082072 25082075 25082082
```

GET → PUT (qty +1) → wait 4s → GET → PUT (qty restored) → wait 10s → fetch audit log → verdict. Each toggled order gets ONE JSON line out: `{"verdict": "ANCHANTO_RETRIGGERED", "anchanto_ids": ["638107", "638108"], ...}`. Full doc in [[fulfilment_workarounds]] §1c. **Caveat:** creates 2 new Anchanto records per order — duplicates must be cancelled by warehouse. Same cost as Hussein's QD-UI qty-toggle (§1b).

## Is the order actually moving? — BQ diagnostic

When orders sit in `pending` and re-syncs no-op, the API alone can't tell you whether the warehouse is stalled, the dispatch is stalled, or the order never reached WMS. Use `ex_api_current.orders` + `ex_api_current.order_state_changes` to read the real state history.

Full guide with SQL, decision table, and gotchas: **`references/fulfilment_movement_check.md`**. Short version:

| Signal | Source | What it means |
|---|---|---|
| `state_updated_at` stuck on creation time | `ex_api_current.orders` | Order has never transitioned — warehouse or WMS stall |
| 0 rows in `order_state_changes` | `ex_api_current.order_state_changes` | Never reached last-mile pipeline (pickers haven't handed off) |
| `shipment_id` populated but `shipment` NULL | `ex_api_current.orders` | Shipment opened but no courier mission live |
| `updated_at` vs `state_updated_at` divergence | same row | Our PUTs touch `updated_at`; only a real state change touches `state_updated_at`. Track progress with the latter. |

## Guardrails — MANDATORY

Mutations against Quiqup data can destroy merchant stock, cancel live orders, or corrupt inventory counts. Before ANY mutating call, pass the "dangerous operation" test below. If the call is dangerous, **HALT and require an explicit, per-call confirmation via `AskUserQuestion`**. A prior approval for a different operation does not carry over. Never batch confirmations ("confirm all these together") — one prompt per operation.

### Dangerous operation classification

A call is **dangerous** if ANY of the following is true:

1. **Cancellation** — any `PATCH` that sets `status` to `cancelled`, `voided`, `refunded`, `closed`, `aborted`, or equivalent terminal/irreversible state (e.g. `PATCH /api/fulfilment/orders/{id}`).
2. **Deletion-equivalent** — any call that removes, zeroes, or renders unusable an existing resource (stock adjustments that take a bucket to 0 or negative, archiving a product, aborting an inbound).
3. **Stock adjustment** — any `POST /api/fulfilment/inventory/adjustments`, regardless of sign or magnitude. Inventory writes are always sensitive.
4. **Bulk commit** — any `POST /api/fulfilment/products/bulk/commit`, or any request whose payload touches **more than 1 item** (count array length in the body; if unknown, assume >1).
5. **Production environment** — any non-GET call with `--env prod`, even if the operation is otherwise benign.
6. **Unknown blast radius** — any call where the number of affected items cannot be counted up-front from the request payload.

### Pre-flight confirmation protocol

For every dangerous call:

1. **Compute blast radius.** State out loud: method, path, environment, resource ID(s), number of items affected, and what field(s) change. If items > 1, list the first 5 IDs and the total count.
2. **Classify reversibility.** Label the operation as REVERSIBLE (can be undone with one opposite call) or IRREVERSIBLE (cancellations, commits, deletions, any stock write). Cancellations are always IRREVERSIBLE.
3. **Ask via `AskUserQuestion`.** Use one question with two options minimum: `Confirm` and `Abort`. Include the full summary from step 1 in the question text. Example:

   ```
   Question: "Confirm PATCH /api/fulfilment/orders/ORD-482 on PROD — set status=cancelled (IRREVERSIBLE, 1 order)?"
   Options: ["Confirm cancel ORD-482 on prod", "Abort"]
   ```

4. **Wait for the answer.** Do NOT run the wrapper until the user picks Confirm. Any other answer (Abort, ambiguous, silence) = abort.
5. **Run the call, then log.** On success, append a line to the active `PROJECT_LOG.md` with timestamp, method, path, env, affected IDs, and the confirmation event. On failure, capture the full response body in the log — never silently retry a mutating call.

### Bulk / multi-item rule (payload OR loop)

A "mass update" exists whenever **more than 1 resource will be mutated**, regardless of whether it's one multi-item payload or a loop of single-item calls. Both count. Both are guardrailed.

Before starting:

- **Count the resources up-front.** Read it from the payload array OR from the driver file (CSV row count, ID list length).
- **Ask once via `AskUserQuestion` with the count in the question text.** Example: `"Confirm PATCH 128 fulfilment orders for Amara Crown on PROD — add 1× AMR-CR-BLK-M to each (IRREVERSIBLE until state returns to pending)?"` Include a sample of the first 3 resource IDs so the user can spot the wrong target.
- **If count > 10, split into batches of ≤10 and ask per batch.** Do NOT bypass by looping or by using a single "batch of batches" confirmation.
- **If count is unknown up-front** (file upload, wildcard expansion), require the user to state the upper bound explicitly in the confirmation answer.
- **After the confirmed batch completes, stop and summarise** before asking for the next batch. Report successes, failures, and any unexpected responses. Do not silently continue to the next batch.

This applies to loops over `$SCRIPT ... PATCH/POST/PUT/DELETE` calls and to multi-item JSON payloads equally. If in doubt, count and ask.

### Absolute refusals (do not ask, just refuse)

- Cancelling any order on `--env prod` within 15 minutes of its creation without the user re-stating the order ID in free text.
- Stock adjustments with `|delta| >= 100` on prod unless the user provides a reason string in the payload AND re-types the SKU in the confirmation answer.
- Any operation when the user is visibly multitasking (asking about unrelated work in the same turn) — finish the other task first, then re-prompt.
- Chaining 3+ mutating calls in one turn without a pause for review between them.

### Safe operations (no AskUserQuestion needed)

- All `GET` requests (any env).
- `POST /api/fulfilment/products/bulk/validate` (validation only, does not persist).
- `POST /api/fulfilment/inbound/book` on staging with test data (still state intent, but skip AskUserQuestion).
- `quiqup.sh token` calls.

## Error handling

- **401 Unauthorized** → run `$SCRIPT token --refresh` then retry; if still 401, verify `.env` credentials.
- **404 Not Found** → confirm the environment (staging ≠ prod IDs) and that the resource exists.
- **422 Unprocessable** → read the response body's `errors[]` array for the offending field; don't guess.
- **429 Too Many Requests** → back off, retry with exponential jitter.
- **Fulfilment PATCH returns `{"code":"internal","message":"unknown code: record not found"}`** → the authenticated partner's catalog lookup failed for the product SKU. This is a **partner-scope** issue, NOT a missing-field issue. The OAuth2 token can read any fulfilment order (loose read scope) but writes validate the SKU against the token's own partner catalog. **Even a Quiqup-admin OAuth2 client cannot PATCH another partner's order** — you must use that specific merchant's auth. Inlining full product details (dimensions, weight, hs_code) does NOT bypass this; the server still joins to the partner's product table. No amount of payload enrichment will make this work cross-partner.

## Auth scope reality check (fulfilment API)

The platform-api accepts two auth flavours with different capabilities:

| Auth type | Issuer | Use case | Gotchas |
|---|---|---|---|
| **OAuth2 client-credentials** | `/oauth/token` (fulfilment host) | Long-lived (1h), fits CLI/automation, plugs into `.env` | **Strictly partner-scoped for writes.** Reads are permissive across partners, writes validate against the client's own partner. |
| **Clerk JWT** | `https://clerk.quiqup.com` | What the Quiqdash BETA UI uses; carries the logged-in user's partner scope | Short-lived (~60s real lifetime despite `exp` claim saying 24h). UI auto-refreshes; curl does not. Not usable for batch scripts without a token-refresh loop. |

**Implications for cross-partner work (e.g. support filling products into a merchant's stuck orders):**

- Always ask the user which partner's credentials we have, not "do we have Quiqup credentials".
- A Quiqup employee's OAuth2 client (e.g. Russian Dolls demo account) can INSPECT any partner's orders but cannot FIX them.
- For a real bulk-fix, you need the merchant's own `client_id`/`client_secret` (OAuth2), OR a rolling supply of fresh Clerk tokens from their Quiqdash session.
- If the user hand-pastes a Clerk token, assume it dies within a minute — plan for re-pastes between batches, or drive the UI via Chrome MCP so the session refreshes itself.

## Post-use logging

When the user explicitly runs an operation against production, append a one-line note to the active `PROJECT_LOG.md` (or the conversation's working doc) recording: date, method, path, purpose, and outcome. Skip logging for read-only / staging calls unless asked.

## Additional Resources

### Reference files
- **`references/endpoints.md`** — Fulfilment API catalogue (inventory, inbound, orders, products). **Includes the cross-border gotcha**: `partner_export` / non-AE-destination orders 404 on `/api/fulfilment/orders/{id}` and must go via `PUT https://api-ae.quiqup.com/orders/export/{id}` instead.
- **`references/lastmile.md`** — Last-Mile API catalogue (orders, parcels, labels, cancellation, state lifecycle, integration patterns)
- **`references/order-ids.md`** — **Which order ID is which.** A last-mile order has 4 distinct IDs (`id`, `uuid`, `partner_order_id`, `client_order_id`). Read this before searching, displaying, or cancelling an order — especially when the user quotes an ID from Quiqdash (that's `client_order_id`, not `id`) or from a merchant's system (that's `partner_order_id`). Also covers the cancel-endpoint `pending`-only restriction.
- **`wiki/quiqup/knowledge_base/quiqup_api_docs/`** — local mirror of developer-docs.quiqup.com for the Fulfilment API (6 top-level + 19 endpoint pages + OpenAPI YAML)

### Scripts
- **`scripts/quiqup.sh`** — the CLI wrapper. Handles token caching, per-env routing, and JSON pretty-printing.
