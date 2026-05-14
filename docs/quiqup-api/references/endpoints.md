# Quiqup Fulfilment API — Endpoint Reference

Full endpoint catalogue. For exhaustive request/response schemas, read the mirrored docs at `wiki/quiqup/knowledge_base/quiqup_api_docs/endpoints/` or the OpenAPI spec at `wiki/quiqup/knowledge_base/quiqup_api_docs/openapi.yaml`.

## Base URLs

| Environment | Base URL |
|-------------|----------|
| Staging     | `https://platform-api.staging.quiqup.com` |
| Production  | `https://platform-api.quiqup.com` |

## Authentication

`POST /oauth/token` with `grant_type=client_credentials`, `client_id`, `client_secret`. Returns `access_token`, `expires_in` (prod: 604800s / 7d; staging: 3600s / 1h), `token_type: bearer`. Pass as `Authorization: Bearer <token>` on every call.

## Fulfilment Inventory

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/fulfilment/inventory` | List all inventory (paged) |
| GET    | `/api/fulfilment/inventory/{sku}` | Inventory for a specific product |
| GET    | `/api/fulfilment/inventory/{sku}/batches` | List batches for a product |
| GET    | `/api/fulfilment/batches/{batchId}` | Single batch detail |
| POST   | `/api/fulfilment/inventory/adjustments` | Adjust stock for a specific bucket |

## Fulfilment Inbound

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/fulfilment/slots/available` | Available booking slots |
| POST   | `/api/fulfilment/inbound/book` | Book an inbound delivery |
| GET    | `/api/fulfilment/inbounds` | List all inbound deliveries |
| GET    | `/api/fulfilment/inbound/{id}` | Single inbound delivery |
| GET    | `/api/fulfilment/inbound/{id}/state-history` | State-transition history |
| GET    | `/api/fulfilment/inbounds/{id}/items` | GRN line items |

## Fulfilment Orders

| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/api/fulfilment/orders` | Create a fulfilment order |
| GET    | `/api/fulfilment/orders/{id}` | Get order by ID |
| PATCH  | `/api/fulfilment/orders/{id}` | Update an order |

## Fulfilment Products

| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/api/fulfilment/products` | Create a product |
| GET    | `/api/fulfilment/products/{sku}` | Get product by SKU |
| PATCH  | `/api/fulfilment/products/{sku}` | Update a product |
| POST   | `/api/fulfilment/products/bulk/validate` | Validate a bulk upload file (phase 1) |
| POST   | `/api/fulfilment/products/bulk/commit` | Commit a validated upload (phase 2) |

## Deep-dive per endpoint

Each endpoint's full request body, response schema, errors, and examples live in a dedicated markdown file:

```bash
ls wiki/quiqup/knowledge_base/quiqup_api_docs/endpoints/
# e.g. fulfilment-orders_post:fulfilment_public_api.createfulfilmentorder.md
```

To read the full spec for a single endpoint:

```bash
cat wiki/quiqup/knowledge_base/quiqup_api_docs/endpoints/fulfilment-orders_post:fulfilment_public_api.createfulfilmentorder.md
```

To grep across all endpoints:

```bash
grep -l "parameter_name" wiki/quiqup/knowledge_base/quiqup_api_docs/endpoints/
```

## Cross-border orders (`partner_export`, non-AE destinations) — different host + path

The fulfilment PATCH endpoint `/api/fulfilment/orders/{id}` only routes domestic orders. For `service_kind` in `{partner_export, partner_next_day}` with a non-AE `shipping_address.country_code` (e.g. QA, SA), it returns:

```
HTTP 500 → internal: request failed: status 404 Not Found: { "code": "not_found", "message": "endpoint not found" }
```

Cross-border orders are served by the **last-mile host** on a different path — confirmed via Quiqdash network inspection 2026-04-19:

| Host | Method | Path |
|------|--------|------|
| `https://api-ae.quiqup.com` (prod) | `PUT` | `/orders/export/{client_order_id}` |

This is the same host as the last-mile API, NOT `platform-api.quiqup.com`. The path lives outside the `/api/fulfilment/*` tree — closer to `/api/lastmile/*` in shape.

**How to detect which route to use:** GET `/api/fulfilment/orders/{id}` and read `service_kind` + `shipping_address.country_code`. If `service_kind` ends in `_export` or destination is non-AE, use the export route; otherwise stick with the fulfilment PATCH.

**Discovered during:** Amara Crown origin-city backfill — 4 of 253 orders (QA + SA destinations) 404'd on the fulfilment route; Quiqdash successfully saved them via `PUT /orders/export/{id}` on `api-ae`.

### Side-effect: export PUT is also a WMS re-sync trigger

An export PUT with an unchanged payload (all fields identical to the current GET) is NOT a no-op — it re-fires the full audit chain (`Order Updated` → `Fulfillment Status Updated` → `Anchanto Order Created`) and re-submits the order to the WMS. Use this to recover orders stuck in `pending` with stale `wms_recreation_failed` errors in `errors[]`.

**Signals a recovery worked:**
- `picking_order_created: true` in the GET response
- `updated_at` refreshed to the current time
- `Anchanto Order Created` appears in the Quiqdash Audit Log

The `errors[]` array can still show the historical failure — it's a log, not a live blocker. Judge recovery by `picking_order_created` and `updated_at`, not by whether `errors[]` is empty.

**Verified on** (2026-04-21): 4 Amara Crown orders (`25096138`, `25096215`, `25082068`, `25081949`) stuck 7–15 days. After one same-payload PUT each, all flipped to `picking_order_created=true` within seconds. No data mutated.

Equivalent manual method: Quiqdash UI → edit order → bump any product qty +1 → save → revert → save. Same event chain.

## Common errors

| HTTP | Cause | Fix |
|------|-------|-----|
| 400  | Invalid `grant_type` or malformed body | Use `grant_type=client_credentials`; validate JSON |
| 401  | Invalid/expired token or bad `client_id`/`client_secret` | Refresh via `quiqup.sh token --refresh` |
| 404  | Unknown SKU / batch / order ID | Verify ID, check environment (staging vs prod) |
| 422  | Business-rule validation failed | Inspect response body `errors[]` for field-level detail |
| 429  | Rate limited | Back off, retry with jitter |

## Refresh the mirror

```bash
# Re-pull all docs (includes any newly published endpoints)
bash wiki/quiqup/knowledge_base/quiqup_api_docs/README.md  # see refresh block at end
```
