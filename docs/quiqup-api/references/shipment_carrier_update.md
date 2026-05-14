---
title: "Shipment carrier + incoterm update"
type: reference
created: 2026-04-27
updated: 2026-04-27
tags: [quiqup-api, fulfilment, anchanto, carrier, incoterms, shipment]
---

# Shipment carrier + incoterm update

Use this endpoint when you only need to set `carrier` / `incoterm` on a fulfilment order. It writes at the **shipment** layer — bypassing the order-update connector entirely. **No Anchanto trigger, no duplicate records, no audit-log verification needed.** Use this in preference to the export PUT (§1 of `fulfilment_workarounds.md`) or the qty-toggle (§1c) when the only fields you want to change are carrier + incoterm.

## Endpoint

```
PUT https://platform-api.quiqup.com/shipments/{shipment_uuid}/update-carrier-details
```

Body:
```json
{
  "carrier_account_name": "ARAMEX",
  "carrier_name":         "ARAMEX",
  "incoterm":             "DDU"
}
```

Field notes:
- `carrier_account_name` and `carrier_name` are usually the same value. Use the carrier display name (`ARAMEX`, `Quiqup`, etc.).
- `incoterm` is **singular** here. (The order layer used both `incoterm` + `incoterms`; this endpoint takes only the singular.)
- All three fields can be omitted independently — pass only what you want to set.

## Auth

**OAuth2 client_credentials** works — same `AMARA_CROWN_CLIENT_ID/SECRET` (or generic `QUIQUP_PARTNER_CLIENT_ID/SECRET`) you use for `wms_resync.py`. Verified 2026-04-27 against 5 Amara shipments, HTTP 200, response confirms `carrier_account.carrier = "ARAMEX"` + `customs_details.incoterms = "DDU"`.

The browser-captured Clerk JWT (Bearer from `business-ae-beta.quiqup.com`) also works, but use OAuth — no expiry juggling, fits unattended cron jobs.

```python
from wms_resync import get_token, load_env_files
load_env_files()
token = get_token(os.environ["AMARA_CROWN_CLIENT_ID"],
                  os.environ["AMARA_CROWN_CLIENT_SECRET"])
```

## Why this is the right path

| Path | Pro | Con |
|---|---|---|
| Export PUT (§1, `wms_resync.py`) | byte-preserving re-sync triggers WMS ingestion | doesn't reliably retrigger Anchanto for carrier/incoterm-only changes; full payload, slow |
| Qty toggle (§1c, `qty_toggle_anchanto.py`) | proven Anchanto retrigger | TWO PUTs, TWO new Anchanto records per order, suffix increments `--N` |
| **Shipment carrier-update** | one PUT, no Anchanto duplicates, no `--N` suffix bump, much faster | scope limited to carrier + incoterm; needs Clerk JWT |

## Mapping order ID → shipment_uuid

The shipment_uuid is NOT exposed on the fulfilment GET. Look it up via BigQuery:

```sql
SELECT client_order_id, shipment_id AS shipment_uuid
FROM `quiqup.ex_api_current.orders`
WHERE client_order_id IN (25082072, 25082075, 25082082)
  AND COALESCE(record_deleted, FALSE) = FALSE;
```

Caveat: `shipment_id` is populated only after a shipment is opened (state past `pending` typically). For pure-`pending` orders without a shipment yet, this endpoint is not yet applicable — the export PUT layer is still the right tool.

## Reference curl (working example, 2026-04-27)

```bash
curl 'https://platform-api.quiqup.com/shipments/88958af0-93f4-45cf-a31b-ca736cf50fd8/update-carrier-details' \
  -X PUT \
  -H "authorization: Bearer ${QUIQUP_BETA_JWT}" \
  -H "content-type: application/json" \
  -H "origin: https://business-ae-beta.quiqup.com" \
  -H "referer: https://business-ae-beta.quiqup.com/" \
  --data-raw '{"carrier_account_name":"ARAMEX","carrier_name":"ARAMEX","incoterm":"DDU"}'
```

Returns `200` with empty body on success. No audit-log fingerprint needed — the field is set on the shipment record directly.

## Verification

The fulfilment GET does **not** expose `incoterm` or `carrier` after the write (same hidden-field pattern as documented in `fulfilment_workarounds.md` §4). To verify:
1. **BigQuery**: `SELECT carrier FROM ex_api_current.orders WHERE client_order_id = ...` — lags ~1 day.
2. **Quiqdash UI**: open the order, the carrier badge updates immediately.
3. **Re-PUT**: idempotent — re-running with the same body returns 200, no side effects.
