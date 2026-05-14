#!/usr/bin/env python3
"""Bulk WMS re-sync via unchanged export PUT.

Use when one or more fulfilment orders are stuck in `pending` despite having
valid data. An `/orders/export/{id}` PUT with a byte-identical payload re-fires
the audit chain (`Order Updated` -> `Fulfillment Status Updated` -> `Anchanto
Order Created`) and nudges WMS ingestion. See
`wiki/quiqup/knowledge_base/fulfilment_workarounds.md` §1 for the theory, and
`references/endpoints.md` for the side-effect note on the export PUT.

Auth: merchant-scoped OAuth2 client_credentials against
`https://platform-api.quiqup.com/oauth/token`. Pass creds via:
  --client-id / --client-secret (flags)     or
  QUIQUP_PARTNER_CLIENT_ID / QUIQUP_PARTNER_CLIENT_SECRET (env)
The same token works for the GET on `platform-api` and the PUT on
`api-ae.quiqup.com` (confirmed 2026-04-21 against Amara Crown).

Usage:
  # Status check only (no PUT) — fast
  wms_resync.py --check 25081880 25081885 25081889

  # Read IDs from stdin
  cat ids.txt | wms_resync.py --check

  # Full re-sync: GET -> PUT unchanged payload -> GET -> verify
  wms_resync.py --resync 25081880 25081885 25081889

  # Parallel (default 8 workers) — order output preserved
  wms_resync.py --resync --workers 12 ...

Verdicts:
  OK           PUT 200, `updated_at` refreshed, `picking_order_created: true`
  NO_CHANGE    PUT 200 but server dedup'd payload (common for cancelled)
  NOT_PICKING  PUT 200 but Anchanto never accepted (data still broken)
  PUT_FAIL     Non-200 or network error — retry usually works
  GET_FAIL     GET returned no body / malformed — order may not exist
  SKIP_NO_PHONE  Both billing + shipping phones empty — payload can't build

Slow in serial (~2s per order). Default 8 parallel workers cuts 80-order runs
from ~3min -> ~25s. Raise `--workers` for larger batches but keep under ~20 to
avoid OAuth rate limiting on the shared partner client.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from collections import Counter

BASE_PLATFORM = "https://platform-api.quiqup.com"
BASE_AE = "https://api-ae.quiqup.com"


def load_env_files() -> None:
    """Walk up from CWD for .env files, plus skill-local .env, and load into os.environ.
    Existing env vars win over file contents (so --client-id flags always override)."""
    candidates: list[pathlib.Path] = []
    cwd = pathlib.Path.cwd()
    for p in [cwd, *cwd.parents]:
        env = p / ".env"
        if env.exists():
            candidates.append(env)
        if (p / ".git").exists():
            break
    skill_env = pathlib.Path(__file__).resolve().parent.parent / ".env"
    if skill_env.exists():
        candidates.append(skill_env)
    for env in candidates:
        for line in env.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def get_token(client_id: str, client_secret: str) -> str:
    r = subprocess.run(
        ["curl", "-sS", "-X", "POST", f"{BASE_PLATFORM}/oauth/token",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"client_id": client_id, "client_secret": client_secret,
                           "grant_type": "client_credentials"})],
        capture_output=True, text=True, timeout=30,
    )
    try:
        return json.loads(r.stdout)["access_token"]
    except Exception:
        sys.exit(f"token fetch failed: {r.stdout[:300]}")


def api_get(token: str, order_id: str) -> dict:
    r = subprocess.run(
        ["curl", "-sS", f"{BASE_PLATFORM}/api/fulfilment/orders/{order_id}",
         "-H", f"Authorization: Bearer {token}"],
        capture_output=True, text=True, timeout=30,
    )
    try:
        return json.loads(r.stdout)
    except Exception as e:
        return {"__error__": f"parse: {e} body={r.stdout[:200]}"}


def api_export_put(token: str, order_id: str, payload: dict) -> tuple[str, dict]:
    r = subprocess.run(
        ["curl", "-sS", "-X", "PUT", f"{BASE_AE}/orders/export/{order_id}",
         "-H", f"Authorization: Bearer {token}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps(payload),
         "-w", "\n|HTTP|%{http_code}"],
        capture_output=True, text=True, timeout=30,
    )
    parts = r.stdout.rsplit("\n|HTTP|", 1)
    body, code = (parts[0], parts[1].strip()) if len(parts) == 2 else (r.stdout, "000")
    try:
        return code, (json.loads(body) if body.strip() else {})
    except Exception:
        return code, {"__raw__": body[:500]}


def build_export_payload(order: dict) -> dict | None:
    """Byte-preserving export payload built from a GET response. Keeps origin,
    destination, products, items, carrier, state exactly as returned — the goal
    is a no-op re-sync, not a fix. Returns None if both contact phones are empty
    (API will reject the payload, so caller can skip)."""
    billing  = dict(order.get("billing_address")  or {})
    shipping = dict(order.get("shipping_address") or {})
    origin   = dict(order.get("origin_address")   or {})
    if not billing.get("phone") and not shipping.get("phone"):
        return None

    products = order.get("products") or []

    def addr_block(a: dict, role: str) -> dict:
        coord = a.get("coordinate") or {}
        return {
            "id": "", "address1": a.get("address1") or "",
            "address2": a.get("address2"), "apartment_number": a.get("apartment_number"),
            "building_name": a.get("building_name"),
            "city": a.get("city"), "town": a.get("town") or a.get("city"),
            "country": a.get("country_code") or a.get("country") or "",
            "postcode": a.get("postcode"),
            "coordinates": {"lat": coord.get("latitude"), "lng": coord.get("longitude")}
                if coord else {"lat": None, "lng": None},
            "ksa_national_address": a.get("ksa_national_address") or "",
        }

    def endpoint(a: dict, role: str) -> dict:
        return {
            "id": "", "contact_name": a.get("contact_name") or a.get("name") or "",
            "contact_phone": a.get("phone") or billing.get("phone") or shipping.get("phone") or "",
            "contact_email": a.get("email") or "", "notes": None,
            "arrived_at": None, "finished_at": None,
            "checked": False, "signature": {"url": None},
            "tracking_token": "", "tracking_url": "", "address": addr_block(a, role),
            "zone": {"parent": "", "parent_group": "", "sector": ""},
            "emirate": "Dubai" if role == "origin" else None,
        }

    def flat_product(p: dict) -> dict:
        d = p.get("dimensions") or {}
        return {
            "description":       p.get("description") or p.get("name") or "",
            "quantity":          p.get("quantity", 1),
            "height":            d.get("height") or p.get("height") or 10,
            "width":             d.get("width")  or p.get("width")  or 10,
            "length":            d.get("length") or p.get("length") or 2,
            "weight":            p.get("weight") or 0.5,
            "sku":               p.get("sku") or "",
            "selling_price":     p.get("selling_price") or 0,
            "country_of_origin": p.get("country_of_origin") or "CN",
            "hs_code":           p.get("hs_code") or "",
            "dangerous_goods":   bool(p.get("dangerous_goods", False)),
        }

    total_weight = round(sum((p.get("weight") or 0.5) * (p.get("quantity") or 1)
                             for p in products), 3) or 0.5

    return {
        "id":             int(order["id"]),
        "uuid":           order.get("uuid", ""),
        "kind":           order.get("service_kind") or "partner_export",
        "service_kind":   order.get("service_kind") or "partner_export",
        "items": [{
            "id": "", "name": "parcel 1", "quantity": 1,
            "weight": str(total_weight),
            "parcel_barcode": f"{order['id']}-1",
            "parcel_barcode_generated_by": "",
            "dimensions": {"height": 10, "length": 10, "width": 10},
        }],
        "products":       [flat_product(p) for p in products],
        "destination":    endpoint(shipping, "destination"),
        "origin":         endpoint(origin,   "origin"),
        "payment_mode":   order.get("payment_mode") or "prepaid",
        "payment_amount": order.get("payment_amount") or 0,
        "state":          order.get("status") or "pending",
        "carrier":        order.get("carrier") or "quiqup",
        "source":         order.get("source") or "shopify-ff",
        "brand_name":     order.get("brand_name") or "",
        "region_name":    "Dubai",
        "partner_order_id": order.get("partner_order_id") or "",
        "weight_kg":      total_weight,
        "weight_unit":    "kg",
        "currency":       order.get("currency") or "AED",
        "shipping_method": "Standard",
        "incoterms":      order.get("incoterms") or "DDU",
    }


def check_one(token: str, oid: str) -> dict:
    o = api_get(token, oid)
    if "__error__" in o or not o.get("id"):
        return {"oid": oid, "verdict": "GET_FAIL", "raw": str(o)[:120]}
    return {
        "oid": oid,
        "status": o.get("status"),
        "pick": o.get("picking_order_created"),
        "updated_at": o.get("updated_at"),
        "service_kind": o.get("service_kind"),
        "verdict": "",
    }


def resync_one(token: str, oid: str) -> dict:
    before = api_get(token, oid)
    if "__error__" in before or not before.get("id"):
        return {"oid": oid, "verdict": "GET_FAIL", "raw": str(before)[:120]}

    payload = build_export_payload(before)
    if payload is None:
        return {"oid": oid, "status": before.get("status"),
                "pick": before.get("picking_order_created"),
                "updated_at": before.get("updated_at"),
                "verdict": "SKIP_NO_PHONE"}

    code, _resp = api_export_put(token, oid, payload)
    after = api_get(token, oid)
    if "__error__" in after or not after.get("id"):
        return {"oid": oid, "put": code, "verdict": "GET_FAIL"}

    moved = after.get("updated_at") != before.get("updated_at")
    pick = after.get("picking_order_created")
    if str(code) != "200":
        verdict = "PUT_FAIL"
    elif pick and moved:
        verdict = "OK"
    elif pick and not moved:
        verdict = "NO_CHANGE"
    elif not pick:
        verdict = "NOT_PICKING"
    else:
        verdict = "CHECK"
    return {
        "oid": oid, "put": code,
        "status_before": before.get("status"),
        "pick_before": before.get("picking_order_created"),
        "updated_before": before.get("updated_at"),
        "status_after": after.get("status"),
        "pick": pick,
        "updated_at": after.get("updated_at"),
        "verdict": verdict,
    }


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="GET-only status check (no PUT). Default if neither --check/--resync given.")
    ap.add_argument("--resync", action="store_true",
                    help="GET -> PUT unchanged payload -> GET -> verify.")
    ap.add_argument("--workers", type=int, default=8,
                    help="Parallel workers (default 8). Keep <=20.")
    ap.add_argument("--client-id", default=None,
                    help="Partner OAuth client_id. Falls back to QUIQUP_PARTNER_CLIENT_ID env.")
    ap.add_argument("--client-secret", default=None,
                    help="Partner OAuth client_secret. Falls back to QUIQUP_PARTNER_CLIENT_SECRET env.")
    ap.add_argument("ids", nargs="*", help="Order IDs. If omitted, read from stdin (one per line or whitespace-separated).")
    return ap.parse_args()


def read_ids(args: argparse.Namespace) -> list[str]:
    if args.ids:
        return args.ids
    if sys.stdin.isatty():
        return []
    return [t for t in sys.stdin.read().split() if t.strip()]


def main() -> int:
    args = parse_args()
    if not args.check and not args.resync:
        args.check = True
    if args.check and args.resync:
        sys.exit("error: choose --check OR --resync, not both")

    load_env_files()
    cid = args.client_id or os.environ.get("QUIQUP_PARTNER_CLIENT_ID") \
        or os.environ.get("AMARA_CLIENT_ID")
    sec = args.client_secret or os.environ.get("QUIQUP_PARTNER_CLIENT_SECRET") \
        or os.environ.get("AMARA_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("error: missing credentials. Pass --client-id/--client-secret "
                 "or set QUIQUP_PARTNER_CLIENT_ID/_SECRET in .env")

    ids = read_ids(args)
    if not ids:
        sys.exit("error: no order IDs supplied (pass as args or stdin)")

    token = get_token(cid, sec)
    op = resync_one if args.resync else check_one

    results: list[dict] = [None] * len(ids)  # type: ignore
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, r in enumerate(ex.map(lambda oid: op(token, oid), ids)):
            results[i] = r

    if args.check:
        print(f"{'order':<12} {'status':<12} {'pick':>5} {'service_kind':<18} {'updated_at':>32}")
        for r in results:
            if r["verdict"] == "GET_FAIL":
                print(f"{r['oid']:<12} GET_FAIL    {'':>5} {'':<18} {r.get('raw',''):>32}")
                continue
            print(f"{r['oid']:<12} {str(r.get('status')):<12} {str(r.get('pick')):>5} "
                  f"{str(r.get('service_kind')):<18} {str(r.get('updated_at')):>32}")
    else:
        print(f"{'order':<12} {'st_b':<10} {'pk_b':>5} {'upd_before':>32} "
              f"{'PUT':>4} {'st_a':<10} {'pk_a':>5} {'upd_after':>32} {'verdict':>12}")
        for r in results:
            if r["verdict"] == "GET_FAIL":
                print(f"{r['oid']:<12} GET_FAIL")
                continue
            print(f"{r['oid']:<12} {str(r.get('status_before')):<10} {str(r.get('pick_before')):>5} "
                  f"{str(r.get('updated_before')):>32} {str(r.get('put')):>4} "
                  f"{str(r.get('status_after')):<10} {str(r.get('pick')):>5} "
                  f"{str(r.get('updated_at')):>32} {r['verdict']:>12}")

    print("\n--- SUMMARY ---")
    c = Counter(r["verdict"] for r in results)
    for k, v in c.most_common():
        print(f"  {k:<14} {v}")
    print(f"  TOTAL          {len(results)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
