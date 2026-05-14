/**
 * Eval runner: recent-orders-v1.
 *
 * Hands each dataset item's natural-language merchant question to Claude with
 * the `recent_orders` tool exposed, captures the tool_use block, and scores
 * it via ./score-recent-orders.ts. Results stream to Langfuse as a trace per
 * item plus scores.
 *
 * Offline: does NOT hit the Quiqup API.
 *
 * Date stability: the dataset's `TODAY` constant ("2026-05-14") is injected
 * into the system prompt so Claude resolves "last 3 days" / "yesterday" from
 * the SAME anchor the expected outputs were authored against. Without this
 * the eval drifts daily and scores become unrepeatable.
 *
 * Tool-spec note: `recent_orders` is registered via the old
 * `server.registerTool(...)` style (no exported `spec`), so this runner
 * mirrors the description and the JSON Schema input shape inline. If the
 * production tool description in lib/tools/recent-orders.ts changes, copy
 * the updated text here too — otherwise the eval drifts from reality.
 *
 * Env vars (auto-loaded by bun from .env.local):
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *   ANTHROPIC_API_KEY
 *
 * Dry-run: set EVAL_DRY_RUN=1 to print item count and exit.
 *
 * Run: `bun run eval:recent-orders`
 */

import {
  items,
  TODAY,
  type RecentOrdersInput,
  type RecentOrdersExpected,
} from "./datasets/recent-orders-v1";

if (process.env.EVAL_DRY_RUN === "1") {
  console.log(
    `recent-orders-v1 dry-run: ${items.length} items (TODAY=${TODAY})`,
  );
  process.exit(0);
}

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");
const { LangfuseClient } = await import("@langfuse/client");
const { AnthropicInstrumentation } = await import(
  "@arizeai/openinference-instrumentation-anthropic"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;

const { evaluators } = await import("./score-recent-orders");

import type { ExperimentTask } from "@langfuse/client";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";

const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new AnthropicInstrumentation()],
});
otelSdk.start();

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

// Inline mirror of lib/tools/recent-orders.ts. Kept verbose so the LLM has
// the same surface here as in production. If you tweak the live tool, mirror
// it here too — there's no shared spec to import (M4 TODO: migrate
// recent_orders to the ToolSpec style so this duplication can go away).
const tool = {
  name: "recent_orders",
  description:
    "Lists recent Quiqup last-mile orders from api-ae.quiqup.com filtered " +
    "by state and date range. Returns a compact projection (id, " +
    "partner_order_id, brand, state, contact, qty). Auth model: the inbound " +
    "OAuth at+jwt is exchanged via Clerk's backend SDK for a session-JWT " +
    "(template 'default') minted for the SAME user, then forwarded to " +
    "Quiqup.",
  input_schema: {
    type: "object" as const,
    properties: {
      state: {
        type: "string",
        enum: [
          "pending",
          "live",
          "in_progress",
          "delivered",
          "failed",
          "cancelled",
        ],
        description: "Order lifecycle state to filter by. Default: pending.",
      },
      from: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description:
          "Inclusive start date YYYY-MM-DD. Defaults to 7 days ago (UTC).",
      },
      to: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Inclusive end date YYYY-MM-DD. Defaults to today (UTC).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max orders to return (1-50). Default 5.",
      },
    },
    additionalProperties: false,
  },
};

interface TaskOutput {
  tool: string | null;
  args: Record<string, unknown> | null;
}

const task: ExperimentTask<RecentOrdersInput, RecentOrdersExpected> = async (
  item,
) => {
  const input = (item as { input?: RecentOrdersInput }).input;
  if (!input?.request) {
    return { tool: null, args: null } satisfies TaskOutput;
  }
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    tools: [tool],
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content:
          "You are an operations assistant for a Dubai-based merchant. " +
          `Today's date is ${TODAY} (UTC). Translate the merchant's question ` +
          "into a recent_orders tool call with the right state, date range, " +
          "and limit. Use YYYY-MM-DD format for from/to. Omit from/to when " +
          "the question has no time window.\n\n" +
          `Question: ${input.request}`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    return { tool: null, args: null } satisfies TaskOutput;
  }
  return {
    tool: block.name,
    args: block.input as Record<string, unknown>,
  } satisfies TaskOutput;
};

const result = await langfuse.experiment.run({
  name: `recent-orders-v1 (${MODEL})`,
  description:
    `Offline tool-call quality baseline for recent_orders on ${MODEL}. ` +
    `6 hand-authored merchant questions, frozen TODAY=${TODAY}. Scored by ` +
    "tool-name-match, required-fields-present (state/limit), and args-overlap.",
  data: items,
  task,
  evaluators,
});

console.log(await result.format());

await langfuse.shutdown();
await otelSdk.shutdown();

// CI gate (opt-in via EVAL_GATE=1; no-op locally).
if (process.env.EVAL_GATE === "1") {
  const { gate } = await import("./gate");
  gate(result, [{ scoreName: "args-overlap", min: 0.8 }]);
}
