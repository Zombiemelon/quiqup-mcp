#!/usr/bin/env python3
"""Update carrier + incoterm on shipments via the dedicated shipment endpoint.

PUT /shipments/{shipment_uuid}/update-carrier-details — sets
`carrier_account_name`, `carrier_name`, `incoterm` on the SHIPMENT layer
(bypasses the order-update connector → no Anchanto retrigger, no duplicate
records). Auth via OAuth2 client_credentials, same as `wms_resync.py`.

Use this in preference to `wms_resync.py`/`qty_toggle_anchanto.py` when the
ONLY change you need is carrier + incoterm. Full doc:
`references/shipment_carrier_update.md`.

Usage:
  # By client_order_id (resolves shipment_id via BigQuery)
  update_carrier_incoterm.py --carrier ARAMEX --incoterm DDU \
    --order-ids 25082072 25082075 25082082

  # By shipment_uuid directly (no BQ lookup)
  update_carrier_incoterm.py --carrier ARAMEX --incoterm DDU \
    --shipment-uuids 88958af0-93f4-45cf-a31b-ca736cf50fd8 ...

Verdicts: HTTP 200 with response body confirming `carrier_account.carrier`
and `customs_details.incoterms`.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from wms_resync import get_token, load_env_files

ENDPOINT = "https://platform-api.quiqup.com/shipments/{uuid}/update-carrier-details"


def put_one(token: str, shipment_uuid: str, carrier: str | None,
            incoterm: str | None) -> dict:
    body: dict = {}
    if carrier:
        body["carrier_account_name"] = carrier
        body["carrier_name"] = carrier
    if incoterm:
        body["incoterm"] = incoterm
    if not body:
        return {"shipment": shipment_uuid, "verdict": "EMPTY_BODY"}

    r = subprocess.run([
        "curl", "-sS", "-X", "PUT",
        ENDPOINT.format(uuid=shipment_uuid),
        "-H", f"authorization: Bearer {token}",
        "-H", "content-type: application/json",
        "-d", json.dumps(body),
        "-w", "\n|HTTP|%{http_code}",
    ], capture_output=True, text=True, timeout=30)
    parts = r.stdout.rsplit("\n|HTTP|", 1)
    raw, code = (parts[0], parts[1].strip()) if len(parts) == 2 else (r.stdout, "000")

    out: dict = {"shipment": shipment_uuid, "http": code}
    try:
        d = json.loads(raw)
        out["client_order_id"] = d.get("order_id")
        out["carrier_after"]   = (d.get("carrier_account") or {}).get("carrier")
        out["incoterms_after"] = (d.get("customs_details") or {}).get("incoterms")
        out["verdict"] = "OK" if code.startswith("2") else f"FAIL_{code}"
    except Exception:
        out["verdict"] = f"PARSE_FAIL_{code}"
        out["raw"] = raw[:300]
    return out


def lookup_shipment_uuids(order_ids: list[str]) -> dict[str, str]:
    """BQ lookup: client_order_id -> shipment_id."""
    sql = (
        "SELECT CAST(client_order_id AS STRING) AS oid, shipment_id "
        "FROM `quiqup.ex_api_current.orders` "
        f"WHERE client_order_id IN ({','.join(order_ids)}) "
        "AND COALESCE(record_deleted, FALSE) = FALSE"
    )
    r = subprocess.run(
        ["bq", "query", "--nouse_legacy_sql", "--format=json", sql],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        sys.exit(f"BQ lookup failed: {r.stderr[:300]}")
    rows = json.loads(r.stdout) if r.stdout.strip() else []
    return {row["oid"]: row["shipment_id"] for row in rows if row.get("shipment_id")}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--carrier")
    p.add_argument("--incoterm")
    p.add_argument("--order-ids", nargs="*", default=[])
    p.add_argument("--shipment-uuids", nargs="*", default=[])
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--client-id")
    p.add_argument("--client-secret")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not (args.carrier or args.incoterm):
        sys.exit("nothing to update — pass --carrier and/or --incoterm")
    if not (args.order_ids or args.shipment_uuids):
        sys.exit("pass --order-ids or --shipment-uuids")

    load_env_files()
    cid = (args.client_id or os.environ.get("AMARA_CROWN_CLIENT_ID")
           or os.environ.get("QUIQUP_PARTNER_CLIENT_ID"))
    sec = (args.client_secret or os.environ.get("AMARA_CROWN_CLIENT_SECRET")
           or os.environ.get("QUIQUP_PARTNER_CLIENT_SECRET"))
    if not (cid and sec):
        sys.exit("missing OAuth creds in env or flags")
    token = get_token(cid, sec)

    shipment_uuids = list(args.shipment_uuids)
    if args.order_ids:
        try:
            mapping = lookup_shipment_uuids(args.order_ids)
        except SystemExit:
            sys.exit("BQ lookup unavailable — pass --shipment-uuids directly")
        for oid in args.order_ids:
            uuid = mapping.get(oid)
            if uuid:
                shipment_uuids.append(uuid)
            else:
                print(json.dumps({"order_id": oid, "verdict": "NO_SHIPMENT_FOUND"}))

    if not shipment_uuids:
        sys.exit("no shipment uuids resolved")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for r in ex.map(lambda u: put_one(token, u, args.carrier, args.incoterm),
                        shipment_uuids):
            print(json.dumps(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
