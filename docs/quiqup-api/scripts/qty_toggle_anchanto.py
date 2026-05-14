#!/usr/bin/env python3
"""Force a fresh `anchanto_order_created` event by qty-toggling via API.

Use when a fulfilment order's byte-preserving export PUT (see `wms_resync.py`)
returns 200 but does NOT fire `anchanto_order_created` in the audit log. The
connector skips the Anchanto trigger for "non-material" updates (carrier,
incoterms, byte-preserving). Bumping a product quantity by +1 forces the
connector to treat the update as material; restoring the quantity then leaves
the order's user-visible state unchanged.

Cost: each PUT that triggers Anchanto creates a NEW Anchanto record. The
default toggle (bump + restore) therefore produces TWO new Anchanto records
per order on top of any pre-existing ones. Warehouse staff must dispatch one
and cancel the duplicates.

Auth: same OAuth2 client_credentials as `wms_resync.py`. Reads either
`AMARA_CROWN_CLIENT_ID/SECRET` (merchant-scoped) or the generic
`QUIQUP_PARTNER_CLIENT_ID/SECRET` from .env.

Usage:
  qty_toggle_anchanto.py 25082072 25082075 25082082

Output: one JSON line per order with verdict + Anchanto IDs created. Verdicts:
  ANCHANTO_RETRIGGERED  fresh anchanto_order_created event(s) fired
  NO_ANCHANTO_EVENT     PUTs succeeded but audit log shows no fresh trigger
  PUT_BUMP_FAIL_<code>  bump PUT non-2xx
  PUT_RESTORE_FAIL_<c>  restore PUT non-2xx
  GET_FAIL              order not found via fulfilment GET
  SKIP_NO_PHONE         payload can't be built
  NO_PRODUCTS           order has empty products[]

Field index: bumps `products[0]` by default. Pass `--product-index N` to bump
a different product (rarely needed; merchants ship line item 0 first). Bump
amount is +1 by default; pass `--bump-by N` for a larger jump (no benefit).

Open question (not yet investigated): is there a single non-material field
that, when mutated, triggers Anchanto WITHOUT requiring a restore? Would let
us produce ONE Anchanto record per order instead of two. Candidates worth
probing: `notes`, `weight` (ship-line scoped), `selling_price`. Test path:
PUT with only that field changed by epsilon, observe audit log. Until proven,
the qty toggle is the canonical force-trigger path.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from wms_resync import (
    api_export_put,
    api_get,
    build_export_payload,
    get_token,
    load_env_files,
)


def fetch_audit(uuid: str) -> list[dict]:
    out: list[dict] = []
    for page in range(1, 5):
        r = subprocess.run(
            ["curl", "-sS",
             f"https://audit.quiqup.com/events?resourceID.eq={uuid}&page={page}"],
            capture_output=True, text=True, timeout=20,
        )
        try:
            d = json.loads(r.stdout)
        except Exception:
            break
        c = d.get("content") or []
        if not c:
            break
        out.extend(c)
        if d.get("is_last_page"):
            break
    return out


def toggle_one(token: str, oid: str, *, product_idx: int, bump_by: int) -> dict:
    start_iso = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    order = api_get(token, oid)
    if "__error__" in order or not order.get("id"):
        return {"oid": oid, "verdict": "GET_FAIL", "raw": str(order)[:120]}
    uuid = order.get("uuid")
    products = order.get("products") or []
    if not products:
        return {"oid": oid, "verdict": "NO_PRODUCTS"}
    if product_idx >= len(products):
        return {"oid": oid, "verdict": "PRODUCT_INDEX_OOB",
                "products_n": len(products)}

    original_qty = products[product_idx].get("quantity", 1)

    payload = build_export_payload(order)
    if payload is None:
        return {"oid": oid, "verdict": "SKIP_NO_PHONE"}
    payload["products"][product_idx]["quantity"] = original_qty + bump_by
    code1, body1 = api_export_put(token, oid, payload)
    if not code1.startswith("2"):
        return {"oid": oid, "verdict": f"PUT_BUMP_FAIL_{code1}",
                "raw": str(body1)[:200]}

    time.sleep(4)

    order2 = api_get(token, oid)
    payload2 = build_export_payload(order2)
    if payload2 is None:
        return {"oid": oid, "verdict": "SKIP_NO_PHONE_RESTORE"}
    payload2["products"][product_idx]["quantity"] = original_qty
    code2, body2 = api_export_put(token, oid, payload2)
    if not code2.startswith("2"):
        return {"oid": oid, "verdict": f"PUT_RESTORE_FAIL_{code2}",
                "raw": str(body2)[:200]}

    time.sleep(10)

    events = fetch_audit(uuid)
    new_anchanto = [e for e in events
                    if e["event_type"].endswith(".anchanto_order_created")
                    and e["create_time"] >= start_iso]
    new_updated  = [e for e in events
                    if e["event_type"].endswith(".order_updated")
                    and e["create_time"] >= start_iso]
    return {
        "oid": oid,
        "partner_order_id": order.get("partner_order_id"),
        "verdict": "ANCHANTO_RETRIGGERED" if new_anchanto else "NO_ANCHANTO_EVENT",
        "qty_was": original_qty,
        "anchanto_events_after": len(new_anchanto),
        "order_updated_events_after": len(new_updated),
        "anchanto_ids": [e["event_data"].get("anchanto_order_id")
                         for e in new_anchanto],
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("ids", nargs="*", help="order IDs (or stdin)")
    p.add_argument("--client-id")
    p.add_argument("--client-secret")
    p.add_argument("--product-index", type=int, default=0)
    p.add_argument("--bump-by", type=int, default=1)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    load_env_files()
    cid = (args.client_id or os.environ.get("AMARA_CROWN_CLIENT_ID")
           or os.environ.get("QUIQUP_PARTNER_CLIENT_ID"))
    sec = (args.client_secret or os.environ.get("AMARA_CROWN_CLIENT_SECRET")
           or os.environ.get("QUIQUP_PARTNER_CLIENT_SECRET"))
    if not (cid and sec):
        sys.exit("missing credentials: set AMARA_CROWN_CLIENT_ID/_SECRET (or "
                 "QUIQUP_PARTNER_CLIENT_ID/_SECRET) in .env, or pass via flags")
    token = get_token(cid, sec)

    ids = args.ids or [line.strip() for line in sys.stdin if line.strip()]
    if not ids:
        sys.exit("usage: qty_toggle_anchanto.py <order_id> ...")

    for oid in ids:
        r = toggle_one(token, oid, product_idx=args.product_index,
                       bump_by=args.bump_by)
        print(json.dumps(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
