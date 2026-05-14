---
title: "How to check if a fulfilment order is actually moving"
type: reference
created: 2026-04-22
updated: 2026-04-22
tags: [quiqup-api, fulfilment, bigquery, wms, diagnosis]
---

# How to check if a fulfilment order is actually moving

Use when an order is "still in `pending`" and you need to tell the difference between:

1. **WMS ingestion failure** — Anchanto never accepted it (fix: export PUT re-sync, §1 of `fulfilment_workarounds.md`)
2. **Data/classification issue** — service_kind wrong, missing phone, blank SKU (fix: field backfill via export PUT)
3. **Warehouse stall** — Anchanto has the order but pickers haven't touched it (fix: escalate to warehouse ops — API cannot help)
4. **Dispatch stall** — picked/packed but no courier handoff (fix: escalate to last-mile ops)

The API alone can't tell these apart. `status: "pending"` is the same string in all 4 cases. Use BigQuery `ex_api_current` to read the state history.

## Quickest answer — the audit log

If you just need to eyeball what happened to an order, open the audit log directly. `resourceID` is the `orders.uuid` (from API GET or `ex_api_current.orders.uuid`):

```
https://audit.quiqup.com/events?resourceID.eq={orders.uuid}
```

Example (order 25082006 → uuid `27c8f7cc-d5d8-47b5-ad42-bd67dac372e0`):

```
https://audit.quiqup.com/events?resourceID.eq=27c8f7cc-d5d8-47b5-ad42-bd67dac372e0
```

Shows the same timeline as the Quiqdash "Audit Log" tab: Order Updated, Anchanto Order Created, Client Order Address Updated, Fulfillment Status Updated — each with `author` (e.g. `admin@amaracrown.com` for merchant OAuth, `csr-automation@quiqup.com` for internal, `system@quiqup.com` for integrations), `source` (Order Management / Shopify Integration), timestamp, and `View Payload` for the full diff.

**Smoking gun for a warehouse stall:** audit log shows only `Anchanto Order Created` at day 0 + subsequent `Order Updated` events, but no `Fulfillment Status Updated` / mission / dispatch events in between → WMS has the order, warehouse hasn't touched it.

Note: this service is UI-only. No public audit API discovered yet. For programmatic triage, fall back to the BQ signals below.

## The three signals

| Signal | Source | What it tells you |
|---|---|---|
| `state_updated_at` | `ex_api_current.orders` | Timestamp of the last **state transition**. If it equals the order-creation time, the order has never moved. |
| Any rows in `order_state_changes` | `ex_api_current.order_state_changes` | Whether the order ever had a mission event (courier dispatch / on_hold / delivered / cancelled / returned). Empty = never reached the last-mile pipeline. |
| `shipment` populated | `ex_api_current.orders` | `shipment_id` is created when the order is opened; the `shipment` field only populates once the courier mission is live. `shipment_id` present but `shipment` NULL = stuck before dispatch. |
| `picking_order_created` (from API GET) | `GET /api/fulfilment/orders/{id}` | True = Anchanto has ingested. False = WMS still hasn't picked it up (re-sync needed). |

Compare `updated_at` (API touch) vs `state_updated_at` (state change) to spot the "we keep re-syncing but nothing actually changes" pattern.

## Diagnostic SQL

```sql
-- Replace the ID list. Partition-filter on updated_at to keep the scan cheap.
WITH ids AS (
  SELECT client_order_id FROM UNNEST([
    25081880, 25081885, 25081889 -- ...
  ]) AS client_order_id
)
SELECT
  o.client_order_id,
  o.state,
  o.state_updated_at,
  o.updated_at AS last_api_touch,
  o.shipment_id IS NOT NULL AS has_shipment_id,
  o.shipment   IS NOT NULL AS shipment_live,
  sc.events,
  sc.distinct_states,
  sc.first_event,
  sc.last_event
FROM `quiqup.ex_api_current.orders` o
LEFT JOIN (
  SELECT
    client_order_id,
    COUNT(*) AS events,
    ARRAY_AGG(DISTINCT state IGNORE NULLS) AS distinct_states,
    MIN(occurred_at) AS first_event,
    MAX(occurred_at) AS last_event
  FROM `quiqup.ex_api_current.order_state_changes`
  WHERE client_order_id IN (SELECT client_order_id FROM ids)
    AND updated_at >= TIMESTAMP('2026-01-01')  -- partition prune
  GROUP BY client_order_id
) sc USING (client_order_id)
WHERE o.client_order_id IN (SELECT client_order_id FROM ids)
  AND o.updated_at >= TIMESTAMP('2026-01-01')
ORDER BY o.state_updated_at ASC;
```

## Reading the output — decision table

| `state` | `state_updated_at` | `events` | `shipment_live` | Diagnosis | Action |
|---|---|---|---|---|---|
| `pending` | equals creation time | 0 | false | **Warehouse stall** — Anchanto ingested but never picked-and-packed | Escalate to warehouse ops. Re-sync won't help (server dedups identical PUTs). |
| `pending` | equals creation time | 0 | false | + `picking_order_created: false` from API | **WMS ingestion failure** | Export PUT re-sync (§1 of fulfilment_workarounds) |
| `pending` | recent | >0 | true | **Dispatch stall** — mission live but not moving | Escalate to last-mile ops, pull mission details |
| `on_hold` | recent | >0 | true | Courier failure in progress | Check `on_hold_reason` in `order_state_changes` |
| `returned_to_origin` | recent | >0 | false | RTO'd — typical cross-border misclassification | Check `return_to_origin_reason`; re-ingest if data fix applies |
| `delivered` | recent | >0 | true | Done. | None. |

## Gotchas

- **`order_state_changes` is last-mile only.** Anchanto warehouse stages (pick started / packed / shipped-to-courier) are NOT in this table. An empty `events` set for a `pending` order means only that the order never reached the courier — it does **not** tell you whether the warehouse has started picking.
- **`updated_at` ≠ `state_updated_at`.** Our export PUT moves `updated_at`. Only a real state change moves `state_updated_at`. Use `state_updated_at` to measure real progress.
- **`ex_api_current` lags the live API by ~1–5 min.** For "did my PUT land?" verification, use the live API (`GET /api/fulfilment/orders/{id}`). For "has this order moved in the last day?", BQ is the right tool.
- **Partition-prune both tables** (`updated_at >= TIMESTAMP(...)`) — `order_state_changes` is 18GB / 55M rows, cluster key is `client_order_id`.

## Case study: Amara Crown 81-order batch (2026-04-22)

Re-synced 81 stuck `pending` orders at 18:18–18:28 UTC on 2026-04-21. 12h later, status check showed:

- `updated_at` refreshed on first push → server accepted payload (OK)
- **Second re-sync 12h later** → 79/81 returned `NO_CHANGE` (server dedup'd identical payload)
- `state_updated_at` **still on 2026-04-06** for all 81 — state hasn't transitioned in 16 days
- `events` in `order_state_changes` = 0 for 77/81; the 4 with events had 1-2 `pending`/`on_hold` transitions on 2026-04-06 and nothing since
- `shipment_id` populated, `shipment` NULL on all 81

Diagnosis: **warehouse stall**, not WMS ingestion or API issue. Re-syncing further is pointless until the warehouse acts. Escalate to ops.
