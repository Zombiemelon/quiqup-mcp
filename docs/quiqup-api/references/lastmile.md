# Quiqup Last-Mile API — Endpoint Reference

Source: https://quiqup.stoplight.io/docs/api-documentation (content pasted by user, not mirrored programmatically).

## Base URLs

| Environment | Base URL |
|-------------|----------|
| Staging     | `https://api.staging.quiqup.com` |
| Production  | `https://api.quiqup.com` (UAE regional variant `https://api-ae.quiqup.com` has been seen in one doc page — confirm with integrations team before hard-coding) |

## Authentication

`POST /oauth/token` — OAuth2 client-credentials flow, but fields are passed as **query parameters**, not JSON body:

```bash
curl --request POST \
  --url 'https://api.staging.quiqup.com/oauth/token?grant_type=client_credentials' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/json' \
  --data '{}' \
  -G --data-urlencode 'client_id=...' --data-urlencode 'client_secret=...'
```

Response:
```json
{ "access_token": "...", "token_type": "bearer", "expires_in": 3600, "created_at": 1616571253 }
```

Token lifetime: **7 days on production**, **1 hour on staging**. Staging and prod have different `client_id` / `client_secret` pairs.

All authenticated requests must include `Authorization: Bearer <token>`.

### Integration patterns (aggregators vs platforms)

Three options to connect merchants to Quiqup:

1. **Billing Identifier** — aggregator uses its own API key; a `billing_identifier` in the payload routes the order to a specific merchant's billing account. Aggregator remains the author, merchant owns the order.
2. **Per-account API keys** — each merchant gets its own key; merchant is both author and owner.
3. **Master key + billing IDs per brand** — hybrid of the two.

Billing IDs can be provided by the client, the aggregator, or Quiqup.

## Endpoints

### Orders

| Method | Path | Purpose | Danger |
|--------|------|---------|--------|
| POST   | `/orders` | Create an order (starts in `pending` state) | mutating |
| GET    | `/orders` | List orders (filters required: `filters[state]`, `from`, `to`, `page`, `per_page`) | safe |
| GET    | `/orders/{order_id}` | Retrieve a single order | safe |
| PUT    | `/orders/{order_id}` | Update a **pending** order (only `payment_mode` + `payment_amount`) | mutating |
| PUT    | `/orders/{order_id}/ready_for_collection` | Mark pending order live — goes to Quiqup dispatch | **irreversible-ish** — guardrailed |
| PUT    | `/orders/batch/set_cancelled` | Cancel one or more pending orders (`{"order_ids":[...]}`) | **cancellation + batch** — guardrailed, confirm per batch |
| POST   | `/orders/{order_id}/parcels` | Add a parcel (item) to a pending order | mutating |
| DELETE | `/orders/{order_id}/parcels/{parcel_id}` | Remove a parcel (not the last one) | **DELETE** — guardrailed |
| GET    | `/order_label/{order_id}` | Download AWB (airway bill) label PDF | safe |

### Create-order payload essentials

```json
{
  "kind": "partner_same_day | partner_next_day | partner_4hr | partner_return",
  "payment_mode": "pre_paid | paid_on_delivery | cash_on_delivery | card_on_delivery",
  "payment_amount": 0,
  "partner_order_id": "client's own reference (recommended to be unique)",
  "billing_identifier": "optional — routes to another account",
  "required_documents": ["customer_identification_photo"],
  "origin": { "contact_name": "...", "contact_phone": "...", "address": { "address1":"...", "coords":[lng,lat], "country":"UAE", "town":"Dubai", "address2":"..." } },
  "destination": { "contact_name": "...", "contact_phone": "...", "share_tracking": true, "address": { ... } },
  "items": [ { "name": "Parcel 1 of 1", "quantity": 1, "parcel_barcode": "optional — Quiqup generates if omitted" } ]
}
```

**Validation rules:**
- `payment_mode = pre_paid` → `payment_amount` must be `0` or `null`.
- `payment_mode = paid_on_delivery` → `payment_amount > 0`.
- Currency defaults to country (AED for UAE).
- Each `item` = one parcel. `quantity` always `1`. If `parcel_barcode` is omitted, Quiqup generates a barcode + label; if provided, partner supplies its own label.

### Order kinds (service types)

| Kind | Description |
|------|-------------|
| `partner_same_day` | Marked ready before cut-off → collected + delivered same day. |
| `partner_next_day` | Marked ready → delivered next day. |
| `partner_4hr` | Ready 8am–6pm → collected + delivered within 4 hours. After 6pm → 4hr delivery starting 12pm next day. |
| `partner_return` | Reverse logistics. Pickup = customer, dropoff = client's return location. |

### Order states (lifecycle)

`pending` → `ready_for_collection` → `out_for_collection` → `collected` → `received_at_depot` → `out_for_delivery` → `delivery_complete` ✓

Other states: `collection_failed` (reason), `delivery_failed` (reason), `return_to_origin`, `out_for_return`, `returned_to_origin` ✓, `cancelled`, `on_hold`, `at_depot`, `scheduled`, `transit` (Dubai ↔ Abu Dhabi).

Reverse flows use the same states minus `return_to_origin` / `returned_to_origin`.

## Guardrail mapping (for `scripts/quiqup.sh`)

The wrapper refuses without `--i-confirmed` when the call is any of:

- `POST /orders` (creates billable work)
- `PUT /orders/{id}` (mutates pending order)
- `PUT /orders/{id}/ready_for_collection` (goes live — triggers dispatch, hard to retract)
- `PUT /orders/batch/set_cancelled` (cancellation + batch — confirm per ≤10 orders)
- `POST /orders/{id}/parcels` (adds billable parcel)
- `DELETE /orders/{id}/parcels/{parcel_id}` (any DELETE is dangerous)
- Any call with `--env prod`

Safe (no AskUserQuestion needed):
- `GET /orders`, `GET /orders/{id}`, `GET /order_label/{id}`
- `quiqup.sh --api lastmile token`

## Examples via the wrapper

```bash
SCRIPT=.claude/skills/quiqup-api/scripts/quiqup.sh
API="--api lastmile"

# Auth
$SCRIPT $API token

# Read-only (safe)
$SCRIPT $API --env prod GET /orders/25161546
$SCRIPT $API GET "/orders?filters[state]=pending&from=2026-04-01&to=2026-04-17&page=1&per_page=20"
$SCRIPT $API --env prod GET /order_label/25161546    # returns PDF bytes — pipe to a file

# Mutations (require confirmation + --i-confirmed)
$SCRIPT $API POST /orders -d @order.json --i-confirmed
$SCRIPT $API PUT /orders/12345/ready_for_collection --i-confirmed
$SCRIPT $API PUT /orders/batch/set_cancelled -d '{"order_ids":[12345]}' --i-confirmed
$SCRIPT $API PUT /orders/12345 -d '{"payment_mode":"pre_paid","payment_amount":0}' --i-confirmed
$SCRIPT $API DELETE /orders/12345/parcels/67890 --i-confirmed
```
