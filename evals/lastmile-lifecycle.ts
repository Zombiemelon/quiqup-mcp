/**
 * Last-Mile order lifecycle eval runner.
 *
 * Walks a synthetic Last-Mile order through one of three lifecycle
 * scenarios end-to-end against the live Quiqup staging API
 * (https://api.staging.quiqup.com), verifies the resulting state, and
 * cleans up. NOT an LLM-in-the-loop eval — payloads are deterministic
 * and we hit the REST API directly. We're testing the API state machine
 * and our cleanup discipline, not LLM tool-call quality.
 *
 * Scenarios:
 *   order_created          POST /orders → GET → assert state === "pending".
 *                          Cleanup: cancel in finally.
 *   ready_for_collection   POST /orders → PUT /orders/{id}/ready_for_collection
 *                          → GET → assert state moved out of pending (any
 *                          non-pending, non-cancelled state is acceptable —
 *                          we report what was observed). Cleanup: best-effort
 *                          cancel (may already be uncancellable post-dispatch).
 *   cancelled              POST /orders → PUT /orders/batch/set_cancelled
 *                          → GET → assert state === "cancelled". No cleanup.
 *
 * Scenarios for out_for_delivery / return_to_origin are out of scope —
 * those transitions are courier-driven and require a separate drive path.
 *
 * Endpoint note: the brief used "POST /orders/cancel" as a placeholder.
 * The canonical staging endpoint (per docs/quiqup-api/references/lastmile.md
 * and the existing roundtrip runner) is `PUT /orders/batch/set_cancelled`
 * with body `{order_ids: [...]}`. This runner uses the canonical endpoint.
 *
 * Auth: OAuth2 client_credentials, same flavour as the roundtrip eval and
 * docs/quiqup-api/scripts/quiqup.sh. NOT the V3b Clerk JWT pipeline the
 * deployed MCP server uses — this validates the API contract directly.
 *
 * Env vars (auto-loaded by bun from .env.local):
 *   QUIQUP_STAGING_CLIENT_ID, QUIQUP_STAGING_CLIENT_SECRET
 *   QUIQUP_LM_STAGING_BASE_URL (default https://api.staging.quiqup.com)
 *
 * Runner contract:
 *   Exports `runOrderCreated`, `runReadyForCollection`, `runCancelled`.
 *   Each returns:
 *     { scenario, orderId, observedStates, pass, notes, error? }
 *
 *   CLI: `bun run evals/lastmile-lifecycle.ts [scenario]`
 *     scenario = "order_created" | "ready_for_collection" | "cancelled"
 *     no arg = run all three sequentially.
 *     Prints JSON to stdout, exits non-zero on any fail.
 *
 * Run: `bun run eval:lastmile-lifecycle [scenario]`
 */

const BASE = process.env.QUIQUP_LM_STAGING_BASE_URL ?? "https://api.staging.quiqup.com";
const CLIENT_ID = process.env.QUIQUP_STAGING_CLIENT_ID;
const CLIENT_SECRET = process.env.QUIQUP_STAGING_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    "Missing QUIQUP_STAGING_CLIENT_ID / QUIQUP_STAGING_CLIENT_SECRET. Add " +
      "staging last-mile client_credentials to .env.local. Get them from " +
      "qadmin.quiqup.com/oauth/clients.",
  );
}

// --- OAuth token cache (per-process; scenarios may run sequentially). ---

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getStagingToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const url =
    `${BASE}/oauth/token?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(CLIENT_ID!)}` +
    `&client_secret=${encodeURIComponent(CLIENT_SECRET!)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`OAuth token fetch failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh 60s before expiry. Staging tokens live 1h.
  cachedToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const token = await getStagingToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

// --- Payload builder ----------------------------------------------------
//
// Canonical staging-verified shape per lib/tools/create-lastmile-order.ts.
// Synthetic Dubai-ish data — no real PII. partner_order_id is unique per
// run so orphans can be grepped if cleanup fails.

type ScenarioId = "order_created" | "ready_for_collection" | "cancelled";

function buildCreatePayload(scenarioId: ScenarioId): Record<string, unknown> {
  const timestamp = Date.now();
  return {
    kind: "partner_same_day",
    payment_mode: "pre_paid",
    payment_amount: 0,
    partner_order_id: `MCP_LIFECYCLE_${scenarioId}_${timestamp}`,
    origin: {
      contact_name: "MCP Test Origin",
      contact_phone: "+971500000001",
      address: {
        address1: "Test Warehouse, Street 1",
        town: "Dubai",
        country: "AE",
      },
    },
    destination: {
      contact_name: "MCP Test Destination",
      contact_phone: "+971500000002",
      address: {
        address1: "Test Building, Street 2",
        town: "Dubai",
        country: "AE",
      },
    },
    items: [{ name: "MCP lifecycle probe", quantity: 1 }],
  };
}

// --- Helpers ------------------------------------------------------------

function extractOrder(body: unknown): { id: number | null; state: string | null } {
  const b = body as { order?: { id?: number; state?: string }; id?: number; state?: string };
  return {
    id: b?.order?.id ?? b?.id ?? null,
    state: b?.order?.state ?? b?.state ?? null,
  };
}

const isOk = (s: number) => s >= 200 && s < 300;

export interface ScenarioResult {
  scenario: ScenarioId;
  orderId: number | null;
  observedStates: string[];
  pass: boolean;
  notes: string;
  error?: string;
}

async function bestEffortCancel(orderId: number, notes: string[]): Promise<void> {
  try {
    const resp = await apiCall("PUT", "/orders/batch/set_cancelled", {
      order_ids: [orderId],
    });
    if (!isOk(resp.status)) {
      const msg =
        `cleanup: PUT /orders/batch/set_cancelled returned ${resp.status} ` +
        `for order ${orderId} (body: ${JSON.stringify(resp.body)})`;
      notes.push(msg);
      console.error(
        `⚠️  ${msg}. Manually clean up: PUT ${BASE}/orders/batch/set_cancelled ` +
          `body {"order_ids":[${orderId}]}`,
      );
    } else {
      notes.push(`cleanup: cancelled order ${orderId} (status ${resp.status})`);
    }
  } catch (e) {
    const msg = `cleanup: cancel threw for order ${orderId}: ${(e as Error).message}`;
    notes.push(msg);
    console.error(`⚠️  ${msg}`);
  }
}

// --- Scenarios ----------------------------------------------------------

export async function runOrderCreated(): Promise<ScenarioResult> {
  const scenario: ScenarioId = "order_created";
  const observedStates: string[] = [];
  const notes: string[] = [];
  let orderId: number | null = null;
  let pass = false;
  let error: string | undefined;

  try {
    const create = await apiCall("POST", "/orders", buildCreatePayload(scenario));
    if (!isOk(create.status)) {
      throw new Error(
        `POST /orders failed: ${create.status} ${JSON.stringify(create.body)}`,
      );
    }
    const created = extractOrder(create.body);
    orderId = created.id;
    if (created.state) observedStates.push(created.state);
    if (orderId === null) {
      throw new Error(`POST /orders returned no order id (body: ${JSON.stringify(create.body)})`);
    }

    const get = await apiCall("GET", `/orders/${orderId}`);
    if (!isOk(get.status)) {
      throw new Error(`GET /orders/${orderId} failed: ${get.status} ${JSON.stringify(get.body)}`);
    }
    const fetched = extractOrder(get.body);
    if (fetched.state) observedStates.push(fetched.state);

    if (fetched.state !== "pending") {
      throw new Error(`expected state "pending", got ${JSON.stringify(fetched.state)}`);
    }

    pass = true;
    notes.push(`order ${orderId} landed in "pending" as expected`);
  } catch (e) {
    error = (e as Error).message;
    notes.push(`failure: ${error}`);
  } finally {
    if (orderId !== null) {
      await bestEffortCancel(orderId, notes);
    }
  }

  return {
    scenario,
    orderId,
    observedStates,
    pass,
    notes: notes.join("; "),
    ...(error ? { error } : {}),
  };
}

export async function runReadyForCollection(): Promise<ScenarioResult> {
  const scenario: ScenarioId = "ready_for_collection";
  const observedStates: string[] = [];
  const notes: string[] = [];
  let orderId: number | null = null;
  let pass = false;
  let error: string | undefined;

  try {
    const create = await apiCall("POST", "/orders", buildCreatePayload(scenario));
    if (!isOk(create.status)) {
      throw new Error(
        `POST /orders failed: ${create.status} ${JSON.stringify(create.body)}`,
      );
    }
    const created = extractOrder(create.body);
    orderId = created.id;
    if (created.state) observedStates.push(created.state);
    if (orderId === null) {
      throw new Error(`POST /orders returned no order id (body: ${JSON.stringify(create.body)})`);
    }

    const ready = await apiCall("PUT", `/orders/${orderId}/ready_for_collection`);
    if (!isOk(ready.status)) {
      throw new Error(
        `PUT /orders/${orderId}/ready_for_collection failed: ${ready.status} ` +
          `${JSON.stringify(ready.body)}`,
      );
    }
    const transitioned = extractOrder(ready.body);
    if (transitioned.state) observedStates.push(transitioned.state);

    const get = await apiCall("GET", `/orders/${orderId}`);
    if (!isOk(get.status)) {
      throw new Error(`GET /orders/${orderId} failed: ${get.status} ${JSON.stringify(get.body)}`);
    }
    const fetched = extractOrder(get.body);
    if (fetched.state) observedStates.push(fetched.state);

    // Accept any non-pending, non-cancelled state. The exact post-dispatch
    // state on staging may be `live`, `accepted`, `ready_for_collection`,
    // or similar — we report what we saw rather than overspecifying.
    const finalState = fetched.state;
    if (finalState === null) {
      throw new Error("GET returned no state");
    }
    if (finalState === "pending") {
      throw new Error(`state did not transition out of "pending"`);
    }
    if (finalState === "cancelled") {
      throw new Error(`unexpected "cancelled" state after ready_for_collection`);
    }

    pass = true;
    notes.push(`order ${orderId} transitioned pending → ${finalState}`);
  } catch (e) {
    error = (e as Error).message;
    notes.push(`failure: ${error}`);
  } finally {
    if (orderId !== null) {
      // Best-effort: post-dispatch the order may no longer be cancellable.
      // bestEffortCancel logs + continues rather than throwing.
      await bestEffortCancel(orderId, notes);
    }
  }

  return {
    scenario,
    orderId,
    observedStates,
    pass,
    notes: notes.join("; "),
    ...(error ? { error } : {}),
  };
}

export async function runCancelled(): Promise<ScenarioResult> {
  const scenario: ScenarioId = "cancelled";
  const observedStates: string[] = [];
  const notes: string[] = [];
  let orderId: number | null = null;
  let pass = false;
  let error: string | undefined;

  try {
    const create = await apiCall("POST", "/orders", buildCreatePayload(scenario));
    if (!isOk(create.status)) {
      throw new Error(
        `POST /orders failed: ${create.status} ${JSON.stringify(create.body)}`,
      );
    }
    const created = extractOrder(create.body);
    orderId = created.id;
    if (created.state) observedStates.push(created.state);
    if (orderId === null) {
      throw new Error(`POST /orders returned no order id (body: ${JSON.stringify(create.body)})`);
    }

    const cancel = await apiCall("PUT", "/orders/batch/set_cancelled", {
      order_ids: [orderId],
    });
    if (!isOk(cancel.status)) {
      throw new Error(
        `PUT /orders/batch/set_cancelled failed: ${cancel.status} ` +
          `${JSON.stringify(cancel.body)}`,
      );
    }
    notes.push(`cancel batch returned ${cancel.status}`);

    const get = await apiCall("GET", `/orders/${orderId}`);
    if (!isOk(get.status)) {
      throw new Error(`GET /orders/${orderId} failed: ${get.status} ${JSON.stringify(get.body)}`);
    }
    const fetched = extractOrder(get.body);
    if (fetched.state) observedStates.push(fetched.state);

    if (fetched.state !== "cancelled") {
      throw new Error(`expected state "cancelled", got ${JSON.stringify(fetched.state)}`);
    }

    pass = true;
    notes.push(`order ${orderId} landed in "cancelled" as expected`);
  } catch (e) {
    error = (e as Error).message;
    notes.push(`failure: ${error}`);
  }
  // No finally: the scenario IS the cancel. No further cleanup needed.

  return {
    scenario,
    orderId,
    observedStates,
    pass,
    notes: notes.join("; "),
    ...(error ? { error } : {}),
  };
}

// --- CLI entrypoint -----------------------------------------------------

const SCENARIOS: Record<ScenarioId, () => Promise<ScenarioResult>> = {
  order_created: runOrderCreated,
  ready_for_collection: runReadyForCollection,
  cancelled: runCancelled,
};

async function main() {
  const arg = process.argv[2];

  if (arg && !(arg in SCENARIOS)) {
    console.error(
      `Unknown scenario "${arg}". Valid: ${Object.keys(SCENARIOS).join(", ")}.`,
    );
    process.exit(2);
  }

  if (arg) {
    const result = await SCENARIOS[arg as ScenarioId]();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  }

  // No arg → run all three sequentially.
  const results: ScenarioResult[] = [];
  for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
    results.push(await SCENARIOS[id]());
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

// Only execute when run directly, not when imported (e.g. by QA harness).
if (import.meta.main) {
  await main();
}
