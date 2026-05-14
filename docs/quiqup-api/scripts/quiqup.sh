#!/usr/bin/env bash
# Quiqup API CLI wrapper — supports BOTH public APIs.
# Handles OAuth2 token caching (per-api × per-environment) and pretty-printed JSON.
#
# Two APIs are supported via --api:
#   fulfilment (default) — warehousing: inventory, inbound, fulfilment orders, products
#                          Base URL: https://platform-api[.staging].quiqup.com
#                          OAuth body: JSON {client_id, client_secret, grant_type}
#   lastmile             — courier/delivery orders
#                          Base URL: https://api[.staging].quiqup.com
#                          OAuth body: query params ?client_id=...&client_secret=...&grant_type=...
#
# Usage:
#   quiqup.sh [--api fulfilment|lastmile] [--env staging|prod] [--raw] METHOD PATH [curl-args...]
#   quiqup.sh token [--api ...] [--env ...] [--refresh]
#
# Examples:
#   quiqup.sh GET /api/fulfilment/inventory
#   quiqup.sh --api lastmile --env prod GET /orders/25161546
#   quiqup.sh --env prod PATCH /api/fulfilment/orders/123 -d '{"status":"cancelled"}' --i-confirmed
#   quiqup.sh --api lastmile token --refresh
#
# Credentials come from .env (repo root or skill-local — skill-local wins).
# Required variables per API:
#   Fulfilment: QUIQUP_CLIENT_ID / _SECRET (staging), QUIQUP_PROD_CLIENT_ID / _SECRET (prod)
#   Last-mile:  QUIQUP_LM_CLIENT_ID / _SECRET (staging), QUIQUP_LM_PROD_CLIENT_ID / _SECRET (prod)
#
# Defaults: --api fulfilment --env prod. Use --env staging for the staging sandbox.

set -euo pipefail

API="fulfilment"
ENV="prod"
RAW=0
REFRESH=0
CONFIRMED=0

usage() { sed -n '2,30p' "$0"; exit 1; }

# Parse global flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    --raw) RAW=1; shift ;;
    --refresh) REFRESH=1; shift ;;
    --i-confirmed) CONFIRMED=1; shift ;;   # set ONLY after AskUserQuestion confirmation
    -h|--help) usage ;;
    *) break ;;
  esac
done

[[ $# -ge 1 ]] || usage

# Load .env files. Skill-local .env takes precedence over repo-root .env —
# later `source` calls overwrite earlier ones, so source repo-root first,
# skill-local second.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

find_repo_env() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  while [[ "$dir" != "/" ]]; do
    [[ -f "$dir/.env" ]] && { echo "$dir/.env"; return; }
    dir="$(dirname "$dir")"
  done
  return 1
}

REPO_ENV="$(find_repo_env || true)"
[[ -n "$REPO_ENV" && -f "$REPO_ENV" ]] && { set -a; source "$REPO_ENV"; set +a; }
[[ -f "$SKILL_DIR/.env" ]] && { set -a; source "$SKILL_DIR/.env"; set +a; }

# Normalize API label
case "$API" in
  fulfilment|fulfillment) API="fulfilment" ;;
  lastmile|last-mile|lm) API="lastmile" ;;
  *) echo "Unknown --api: $API (use fulfilment or lastmile)" >&2; exit 2 ;;
esac

# Resolve base URL, OAuth URL, and credentials per (API, ENV).
# IMPORTANT: Fulfilment and Last-Mile share the SAME OAuth endpoint and the SAME
# credentials — `/oauth/token` on the fulfilment host, using QUIQUP_CLIENT_ID /
# QUIQUP_CLIENT_SECRET (or the _PROD_ variants). BASE_URL differs only for the
# actual API calls after the token is issued.
# LM-specific env vars are supported as overrides for partners who have
# dedicated last-mile credentials, but fall back to the fulfilment creds when unset.
case "$ENV" in
  staging)
    OAUTH_URL="https://platform-api.staging.quiqup.com/oauth/token"
    if [[ "$API" == "fulfilment" ]]; then
      BASE_URL="https://platform-api.staging.quiqup.com"
    else
      BASE_URL="https://api.staging.quiqup.com"
    fi
    CLIENT_ID="${QUIQUP_LM_CLIENT_ID:-${QUIQUP_CLIENT_ID:-}}"
    CLIENT_SECRET="${QUIQUP_LM_CLIENT_SECRET:-${QUIQUP_CLIENT_SECRET:-}}"
    CRED_HINT="QUIQUP_CLIENT_ID / QUIQUP_CLIENT_SECRET"
    ;;
  prod|production)
    ENV="prod"
    OAUTH_URL="https://platform-api.quiqup.com/oauth/token"
    if [[ "$API" == "fulfilment" ]]; then
      BASE_URL="https://platform-api.quiqup.com"
    else
      # Last-mile prod: UAE regional host. `api.quiqup.com` does not currently
      # accept connections on 443; `api-ae.quiqup.com` is the live prod host.
      BASE_URL="https://api-ae.quiqup.com"
    fi
    CLIENT_ID="${QUIQUP_LM_PROD_CLIENT_ID:-${QUIQUP_PROD_CLIENT_ID:-}}"
    CLIENT_SECRET="${QUIQUP_LM_PROD_CLIENT_SECRET:-${QUIQUP_PROD_CLIENT_SECRET:-}}"
    CRED_HINT="QUIQUP_PROD_CLIENT_ID / QUIQUP_PROD_CLIENT_SECRET"
    ;;
  *) echo "Unknown env: $ENV (use staging or prod)" >&2; exit 2 ;;
esac

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "ERROR: Missing credentials for api=$API env=$ENV." >&2
  echo "Set $CRED_HINT in .env (repo root or skill-local)." >&2
  exit 3
fi

CACHE_DIR="${TMPDIR:-/tmp}"
CACHE_FILE="$CACHE_DIR/quiqup_token_${API}_${ENV}.json"

get_token() {
  # Reuse cached token if still valid (skip if --refresh)
  if [[ $REFRESH -eq 0 && -f "$CACHE_FILE" ]]; then
    local now expires
    now=$(date +%s)
    expires=$(python3 -c "import json,sys;print(json.load(open('$CACHE_FILE')).get('expires_at',0))" 2>/dev/null || echo 0)
    if [[ "$expires" -gt "$((now + 60))" ]]; then
      python3 -c "import json;print(json.load(open('$CACHE_FILE'))['access_token'])" < "$CACHE_FILE"
      return
    fi
  fi
  # Fetch new token — both APIs use the SAME OAuth endpoint (fulfilment host)
  # and the same JSON-body flow. Token issued here is valid for both APIs.
  local resp
  resp=$(curl -sS -X POST "$OAUTH_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"client_id\":\"$CLIENT_ID\",\"client_secret\":\"$CLIENT_SECRET\",\"grant_type\":\"client_credentials\"}")
  if ! echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);assert 'access_token' in d" 2>/dev/null; then
    echo "Token fetch failed (api=$API env=$ENV): $resp" >&2; exit 4
  fi
  python3 - "$CACHE_FILE" <<PY
import json, sys, time
resp = json.loads('''$resp''')
resp['expires_at'] = int(time.time()) + int(resp.get('expires_in', 3600))
open(sys.argv[1], 'w').write(json.dumps(resp))
print(resp['access_token'])
PY
}

# Token subcommand
if [[ "$1" == "token" ]]; then
  get_token
  exit 0
fi

METHOD="$1"; PATH_="$2"; shift 2

# ---- Guardrail: dangerous-call gate ----------------------------------------
# Refuse any cancellation, stock adjustment, bulk/commit, or prod-mutation
# unless caller explicitly passes --i-confirmed (set ONLY after an explicit
# AskUserQuestion confirmation — see SKILL.md "Guardrails — MANDATORY").
METHOD_UP="$(echo "$METHOD" | tr '[:lower:]' '[:upper:]')"
BODY=""
prev=""
# Best-effort: extract -d/--data payload for payload-based danger checks
for a in "$@"; do
  case "$prev" in
    -d|--data|--data-raw|--data-binary) BODY="$a" ;;
  esac
  prev="$a"
done

DANGER_REASON=""
if [[ "$METHOD_UP" != "GET" ]]; then
  # Prod mutation
  if [[ "$ENV" == "prod" ]]; then
    DANGER_REASON="non-GET on PROD"
  fi
  # Any DELETE, anywhere
  if [[ "$METHOD_UP" == "DELETE" ]]; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }DELETE request"
  fi
  # Cancellation / terminal-state set (either as status field OR path like .../set_cancelled)
  if echo "$BODY" | grep -qiE '"(status|state)"[[:space:]]*:[[:space:]]*"(cancelled|canceled|voided|refunded|closed|aborted)"'; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }cancellation/terminal-status"
  fi
  if [[ "$PATH_" == *"set_cancelled"* || "$PATH_" == *"set_canceled"* || "$PATH_" == *"/cancel"* ]]; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }cancellation endpoint"
  fi
  # Any /batch/ path on last-mile (acts on multiple orders)
  if [[ "$PATH_" == *"/batch/"* || "$PATH_" == *"/batch"* ]]; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }batch endpoint"
  fi
  # Stock adjustment (fulfilment)
  if [[ "$PATH_" == *"/inventory/adjustments"* ]]; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }stock adjustment"
  fi
  # Bulk commit (fulfilment)
  if [[ "$PATH_" == *"/bulk/commit"* ]]; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }bulk commit"
  fi
  # Mark ready for collection (last-mile) — makes the order LIVE, irreversible in effect
  if [[ "$PATH_" == *"/ready_for_collection"* ]]; then
    DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }mark ready-for-collection (goes live)"
  fi
  # Multi-item payload detection (arrays of items/products/orders/adjustments/skus/order_ids/parcels)
  if [[ -n "$BODY" ]]; then
    COUNT=$(python3 -c "
import json,sys
try:
    d=json.loads('''$BODY''')
except Exception:
    print(0); sys.exit()
if isinstance(d,list):
    print(len(d))
elif isinstance(d,dict):
    for k in ('items','products','orders','adjustments','skus','order_ids','parcels'):
        if isinstance(d.get(k),list):
            print(len(d[k])); sys.exit()
    print(1)
else:
    print(0)
" 2>/dev/null || echo 0)
    if [[ "$COUNT" -gt 1 ]]; then
      DANGER_REASON="${DANGER_REASON:+$DANGER_REASON + }multi-item payload ($COUNT items)"
    fi
    if [[ "$COUNT" -gt 10 ]]; then
      echo "REFUSED: payload touches $COUNT items — max per call is 10. Split into batches and confirm each." >&2
      exit 10
    fi
  fi
fi

if [[ -n "$DANGER_REASON" && $CONFIRMED -eq 0 ]]; then
  cat >&2 <<EOF
REFUSED: dangerous operation — $DANGER_REASON
  method : $METHOD_UP
  path   : $PATH_
  env    : $ENV
Rerun with --i-confirmed AFTER obtaining explicit user confirmation via AskUserQuestion.
See SKILL.md "Guardrails — MANDATORY".
EOF
  exit 11
fi
# ---- end guardrail ---------------------------------------------------------

TOKEN="$(get_token)"
URL="$BASE_URL$PATH_"

if [[ $RAW -eq 1 ]]; then
  curl -sS -X "$METHOD" "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    "$@"
else
  curl -sS -X "$METHOD" "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    "$@" | python3 -m json.tool 2>/dev/null || true
fi
