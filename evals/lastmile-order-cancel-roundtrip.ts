/**
 * Online round-trip eval: create + cancel via TWO Claude turns.
 *
 * Pattern:
 *   Turn 1 — Claude is asked to CREATE a TEST last-mile order. The runner
 *            POSTs the args to /orders on staging and records order_id.
 *   Turn 2 — Claude is asked to CANCEL the order it just created. Both
 *            `cancel_lastmile_orders_batch` and a single-order alternative
 *            `cancel_lastmile_order` are exposed so we can score whether the
 *            LLM correctly reaches for the BATCH tool even when cancelling
 *            one order.
 *
 * Hits the real Quiqup staging API at https://api.staging.quiqup.com using
 * OAuth2 client_credentials (same flavour as docs/quiqup-api/scripts/quiqup.sh).
 * NOTE: this is NOT the V3b Clerk-session-JWT path the deployed MCP uses.
 *
 * Env vars (auto-loaded by bun from .env.local):
 *   QUIQUP_STAGING_CLIENT_ID, QUIQUP_STAGING_CLIENT_SECRET  — required
 *   QUIQUP_LM_STAGING_BASE_URL (default https://api.staging.quiqup.com)
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *   ANTHROPIC_API_KEY
 *
 * Dry-run: EVAL_DRY_RUN=1 prints item count and exits BEFORE the secrets
 * check, so CI can shape-check without staging credentials.
 *
 * Run: `bun run eval:lastmile-cancel`
 */

import {
  items,
  type CancelRoundtripInput,
  type CancelRoundtripExpected,
} from "./datasets/lastmile-cancel-roundtrip-v1";

if (process.env.EVAL_DRY_RUN === "1") {
  console.log(`lastmile-cancel-roundtrip-v1 dry-run: ${items.length} items`);
  process.exit(0);
}

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");
const { LangfuseClient } = await import("@langfuse/client");
const { AnthropicInstrumentation } = await import(
  "@arizeai/openinference-instrumentation-anthropic"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;

const { spec: createLastmileOrderSpec } = await import(
  "@/lib/tools/create-lastmile-order"
);
const { spec: cancelBatchSpec } = await import(
  "@/lib/tools/cancel-lastmile-orders-batch"
);

import type { ExperimentTask } from "@langfuse/client";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";
const BASE =
  process.env.QUIQUP_LM_STAGING_BASE_URL ?? "https://api.staging.quiqup.com";
const CLIENT_ID = process.env.QUIQUP_STAGING_CLIENT_ID;
const CLIENT_SECRET = process.env.QUIQUP_STAGING_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    "Missing QUIQUP_STAGING_CLIENT_ID / QUIQUP_STAGING_CLIENT_SECRET. Add " +
      "staging last-mile client_credentials to .env.local. Get them from " +
      "qadmin.quiqup.com/oauth/clients.",
  );
}

const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new AnthropicInstrumentation()],
});
otelSdk.start();

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

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
  cachedToken = {
    value: j.access_token,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  };
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

// Tools exposed to Claude on each turn. Schemas left wide-open
// (additionalProperties: true) because we want to measure tool-choice and
// raw arg quality at the description level, matching the roundtrip eval
// pattern.
const createTool = {
  name: createLastmileOrderSpec.name,
  description: createLastmileOrderSpec.description,
  input_schema: { type: "object" as const, additionalProperties: true },
};
const cancelBatchTool = {
  name: cancelBatchSpec.name,
  description: cancelBatchSpec.description,
  input_schema: { type: "object" as const, additionalProperties: true },
};
// Decoy single-order cancel tool. NOT a real MCP tool — its presence lets us
// score whether the LLM correctly picks the BATCH variant when cancelling
// one order. If we only expose the batch tool, "did the LLM pick the right
// one?" is trivial. With a plausible single-order alternative present, the
// score has signal.
const cancelSingleTool = {
  name: "cancel_lastmile_order",
  description:
    "(Alternative) Cancel a single Quiqup last-mile order by id. Prefer " +
    "cancel_lastmile_orders_batch when the canonical batch endpoint is " +
    "available.",
  input_schema: {
    type: "object" as const,
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
  },
};

interface TaskOutput {
  createToolName: string | null;
  createArgs: Record<string, unknown> | null;
  create: { status: number; body: unknown } | null;
  orderId: number | null;
  cancelToolName: string | null;
  cancelArgs: Record<string, unknown> | null;
  cancel: { status: number; body: unknown } | null;
}

const task: ExperimentTask<
  CancelRoundtripInput,
  CancelRoundtripExpected
> = async (item) => {
  const input = (item as { input?: CancelRoundtripInput }).input;
  const out: TaskOutput = {
    createToolName: null,
    createArgs: null,
    create: null,
    orderId: null,
    cancelToolName: null,
    cancelArgs: null,
    cancel: null,
  };
  if (!input?.request) return out;

  // Turn 1 — CREATE.
  const createRes = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [createTool],
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content:
          "You are a logistics assistant for a Dubai-based merchant. " +
          "Translate the merchant's request into a create_lastmile_order " +
          "tool call. Use sensible defaults for unspecified fields.\n\n" +
          `Request: ${input.request}`,
      },
    ],
  });
  const createBlock = createRes.content.find((b) => b.type === "tool_use");
  if (!createBlock || createBlock.type !== "tool_use") return out;
  out.createToolName = createBlock.name;
  out.createArgs = createBlock.input as Record<string, unknown>;

  try {
    out.create = await apiCall("POST", "/orders", out.createArgs);
    const cb = out.create.body as { order?: { id?: number }; id?: number };
    out.orderId = cb?.order?.id ?? cb?.id ?? null;

    // Turn 2 — CANCEL. Only attempted if we have an order_id from the create.
    if (out.orderId !== null) {
      const cancelRes = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        tools: [cancelBatchTool, cancelSingleTool],
        tool_choice: { type: "any" },
        messages: [
          {
            role: "user",
            content:
              "You are the same logistics assistant. The order you just " +
              `created has order_id ${out.orderId}. The merchant has now ` +
              "changed their mind and wants it cancelled. Cancel it using " +
              "the appropriate cancellation tool.",
          },
        ],
      });
      const cancelBlock = cancelRes.content.find((b) => b.type === "tool_use");
      if (cancelBlock && cancelBlock.type === "tool_use") {
        out.cancelToolName = cancelBlock.name;
        out.cancelArgs = cancelBlock.input as Record<string, unknown>;
      }
    }
  } finally {
    // Cleanup: ALWAYS attempt batch cancel on the staging side so we don't
    // leak test orders, regardless of which tool the LLM picked (or even if
    // it didn't pick one). This is the safety net, not the score input —
    // `cancel-2xx` is scored on this real API call.
    if (out.orderId !== null) {
      try {
        out.cancel = await apiCall("PUT", "/orders/batch/set_cancelled", {
          order_ids: [out.orderId],
        });
        if (out.cancel.status < 200 || out.cancel.status >= 300) {
          console.error(
            `Failed to cancel order ${out.orderId} on staging (status ` +
              `${out.cancel.status}). Manually clean up: PUT ` +
              `${BASE}/orders/batch/set_cancelled body ` +
              `{"order_ids":[${out.orderId}]}`,
          );
        }
      } catch (e) {
        console.error(`Cancel threw for order ${out.orderId}:`, e);
      }
    }
  }

  return out;
};

// --- Scorers ---

const isOk = (s: number | undefined) => typeof s === "number" && s >= 200 && s < 300;

const createOk = async ({ output }: { output: TaskOutput }) => {
  const status = output.create?.status;
  return {
    name: "create-2xx",
    value: isOk(status) ? 1 : 0,
    comment: `POST /orders → ${status ?? "<no call>"}`,
  };
};

const cancelViaBatchTool = async ({ output }: { output: TaskOutput }) => {
  const picked = output.cancelToolName;
  const match = picked === "cancel_lastmile_orders_batch";
  return {
    name: "cancel-via-batch-tool",
    value: match ? 1 : 0,
    comment: `Cancel turn picked: ${picked ?? "<no tool call>"}`,
  };
};

const cancelOk = async ({ output }: { output: TaskOutput }) => {
  const status = output.cancel?.status;
  return {
    name: "cancel-2xx",
    value: isOk(status) ? 1 : 0,
    comment: `PUT /orders/batch/set_cancelled → ${status ?? "<no call>"}`,
  };
};

const result = await langfuse.experiment.run({
  name: `lastmile-order-cancel-roundtrip-v1 (${MODEL})`,
  description:
    `Two-turn online eval against ${BASE}. Turn 1 creates, turn 2 cancels. ` +
    "Scores: create-2xx, cancel-via-batch-tool (did LLM pick the batch " +
    "endpoint?), cancel-2xx. Auth: OAuth2 client_credentials (NOT V3b JWT).",
  data: items,
  task,
  evaluators: [createOk, cancelViaBatchTool, cancelOk],
});

console.log(await result.format());

await langfuse.shutdown();
await otelSdk.shutdown();

// CI gate (opt-in via EVAL_GATE=1; no-op locally).
if (process.env.EVAL_GATE === "1") {
  const { gate } = await import("./gate");
  gate(result, [
    { scoreName: "create-2xx", min: 1.0 },
    { scoreName: "cancel-2xx", min: 1.0 },
  ]);
}
