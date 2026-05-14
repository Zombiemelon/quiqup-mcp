# Quiqup Order IDs — what's what

A single last-mile order carries **four distinct identifiers**. Picking the right one matters: the API path expects one, Quiqdash shows another, merchants quote a third, and internal joins use a fourth. The names collide across systems — pay attention.

## The four IDs (and the naming collision)

| Meaning | API response field | BigQuery column (`quiqup.ex_api_current.orders`) | Example | Used for |
|---|---|---|---|---|
| **Public / display ID** (what Quiqdash shows and what the **last-mile API path expects**) | `id` | `client_order_id` | `25155469` | `GET/PUT /orders/{id}`, `{"order_ids":[...]}` in batch-cancel, tracking URLs |
| Internal sequence ID (back-office only) | — (not returned) | `id` | `77548668` | Internal joins; **NOT a valid API path parameter** |
| UUID | `uuid` | `uuid` | `f0fe34b2-fef5-4406-86ae-ea59177fb06a` | Tracking tokens, fulfilment API cross-refs |
| Merchant's own reference | `partner_order_id` | `partner_order_id` | `"254508995"` | What merchants quote in tickets. **Not a valid API path parameter** — resolve via BigQuery first. |

**Gotcha:** BigQuery's `id` column and the API response's `id` field refer to DIFFERENT numbers. `bq.id` = internal; `api.id` = `bq.client_order_id`. When the user says "the order ID is X", X is almost always the public/display ID (`bq.client_order_id`, 8-digit 25xxxxxx range as of April 2026) — feed that to the API directly.

## Resolving one ID to another

Last-mile API has no search endpoint that takes `partner_order_id`. Query BigQuery:

```sql
SELECT id                    AS bq_internal_id,        -- NOT for API paths
       client_order_id       AS public_display_id,     -- use this in API paths
       uuid, partner_order_id, business_partner_id, state
FROM `quiqup.ex_api_current.orders`
WHERE partner_order_id = '254508995';
```

Then call the API with `client_order_id`:

```bash
$SCRIPT --api lastmile GET /orders/25155469
```

Key columns:
- `business_partner_id` — Salesforce account ID (e.g., `001P400000lFh6QIAS` → Reef Perfume GP). Join to `quiqup.salesforce_current.accounts` for merchant name.
- `state` — see cancellation workflow below.
- The view `quiqup.views.order_with_order_financials` exposes `client_order_id` (correct) and `grandparent_account_name_c`, but **not** `partner_order_id` — use `ex_api_current.orders` when searching by merchant reference.

## Fulfilment vs last-mile disambiguation

A numeric order ID alone doesn't tell you which API owns it. If `GET /orders/{id}` on last-mile returns `{"order": null}`, try fulfilment (`GET /api/fulfilment/orders/{id}`) before concluding the ID is wrong. Fulfilment and last-mile use separate ID spaces.

## Cancellation workflow

### The hard rule
`PUT /orders/batch/set_cancelled` only accepts orders in **`pending`** or **`ready_for_collection`** state. Any other state (`collection_failed`, `delivery_complete`, already `cancelled`, in-transit, etc.) returns **500 Internal Server Error** — not 422, not a friendly message. Always `GET /orders/{id}` and check `state` before attempting cancel.

### The `collection_failed` → cancel workflow (API-only, no Quiqdash needed)

A `collection_failed` order cannot be cancelled directly — batch-cancel returns:
```
"The state transition to 'cancelled' is not allowed for orders: ..."
```

**The full workaround is API-driven.** `PUT /orders/{id}/ready_for_collection` accepts `collection_failed` orders as input (despite docs suggesting it's for `pending` only), flipping them back to `ready_for_collection`. From there, batch-cancel works.

Steps:

1. Resolve `partner_order_id` → `client_order_id` via BigQuery if needed.
2. For each stuck order: `PUT /orders/{client_order_id}/ready_for_collection --i-confirmed`. Response body contains the updated order; confirm `state: ready_for_collection`.
3. Batch-cancel: `PUT /orders/batch/set_cancelled -d '{"order_ids":[...]}' --i-confirmed`. Up to 10 IDs per batch per the guardrail; each must be cancellable (`pending` or `ready_for_collection`).
4. Response is a JSON array of the cancelled orders, each with `state: "cancelled"` and a fresh `state_updated_at`.

Real example (2026-04-17): four Reef Perfumes orders stuck in `collection_failed`. One was flipped manually via Quiqdash first (25155469 / partner 254508995), then the remaining three (25155457, 25155556, 25155565) were fully processed via API — flip + batch-cancel — without touching Quiqdash. Both approaches worked.

### 500 vs 422 on batch-cancel
Early attempts returned a bare `{"error":"Internal Server Error"}`, but later calls returned a structured message naming the offending order IDs and the forbidden transition. Behaviour seems inconsistent — treat a 500 from this endpoint as "state transition rejected" and verify with `GET /orders/{id}` rather than retrying.

### To abort post-dispatch orders
Once an order is in transit, out-for-delivery, or delivered, cancellation is an ops action, not an API call. Coordinate with Quiqup ops.
