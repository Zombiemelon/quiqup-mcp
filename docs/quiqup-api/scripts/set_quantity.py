#!/usr/bin/env python3
"""Set products[line_index].quantity to target via export PUT, then verify.

Use to correct drifted quantities left by failed `qty_toggle_anchanto.py`
restore-PUTs (~30% silent-failure rate observed on Amara Crown 2026-04-27).

ONE PUT per order. Triggers `anchanto_order_created` (new duplicate record),
same cost as the qty toggle's bump-PUT. Use only when an order's stored qty
no longer matches the merchant's truth.

Usage (one order per line on stdin or argv):
  set_quantity.py 25082174:0:1 25082121:1:1 25082114:0:1
  cat fixes.txt | set_quantity.py        # each line: oid:line:target

Verdicts:
  OK              PUT 200 + GET-after confirms qty == target
  PUT_FAIL_<code> non-2xx PUT
  STILL_WRONG     PUT 200 but GET-after shows qty != target (silent skip)
  GET_FAIL        order not found
  SKIP_NO_PHONE   payload can't be built
"""
from __future__ import annotations

import json
import os
import sys
import time
import argparse

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from wms_resync import (
    api_export_put,
    api_get,
    build_export_payload,
    get_token,
    load_env_files,
)


def fix_one(token: str, oid: str, line_idx: int, target_qty: int) -> dict:
    o = api_get(token, oid)
    if "__error__" in o or not o.get("id"):
        return {"oid": oid, "verdict": "GET_FAIL", "raw": str(o)[:120]}
    products = o.get("products") or []
    if line_idx >= len(products):
        return {"oid": oid, "verdict": "LINE_OOB", "lines": len(products)}

    qty_before = products[line_idx].get("quantity", 0)
    sku = products[line_idx].get("sku")

    pl = build_export_payload(o)
    if pl is None:
        return {"oid": oid, "verdict": "SKIP_NO_PHONE"}
    pl["products"][line_idx]["quantity"] = target_qty
    code, body = api_export_put(token, oid, pl)
    if not code.startswith("2"):
        return {"oid": oid, "verdict": f"PUT_FAIL_{code}", "raw": str(body)[:200]}

    # Verify
    time.sleep(3)
    o2 = api_get(token, oid)
    qty_after = ((o2.get("products") or [{}] * (line_idx + 1))[line_idx] or {}).get("quantity")
    return {
        "oid": oid,
        "partner_order_id": o.get("partner_order_id"),
        "sku": sku,
        "line_index": line_idx,
        "qty_before": qty_before,
        "target": target_qty,
        "qty_after": qty_after,
        "verdict": "OK" if qty_after == target_qty else "STILL_WRONG",
    }


def parse_spec(s: str) -> tuple[str, int, int]:
    parts = s.strip().split(":")
    if len(parts) != 3:
        sys.exit(f"bad spec {s!r} — expected oid:line:target")
    return parts[0], int(parts[1]), int(parts[2])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("specs", nargs="*", help="oid:line:target tuples")
    ap.add_argument("--client-id")
    ap.add_argument("--client-secret")
    args = ap.parse_args()

    load_env_files()
    cid = (args.client_id or os.environ.get("AMARA_CROWN_CLIENT_ID")
           or os.environ.get("QUIQUP_PARTNER_CLIENT_ID"))
    sec = (args.client_secret or os.environ.get("AMARA_CROWN_CLIENT_SECRET")
           or os.environ.get("QUIQUP_PARTNER_CLIENT_SECRET"))
    if not (cid and sec):
        sys.exit("missing OAuth creds")
    token = get_token(cid, sec)

    raw = args.specs or [line for line in sys.stdin.read().split() if line.strip()]
    if not raw:
        sys.exit("usage: set_quantity.py oid:line:target ...")

    for spec in raw:
        oid, line, target = parse_spec(spec)
        r = fix_one(token, oid, line, target)
        print(json.dumps(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
