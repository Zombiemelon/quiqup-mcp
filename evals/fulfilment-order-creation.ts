/**
 * Eval runner: fulfilment-order-creation-v1.
 *
 * Hands each dataset item's natural-language request to Claude with the
 * `create_fulfilment_order` tool exposed, captures the tool_use block, and
 * scores it via ../score-fulfilment-tool-call.ts. Results stream to Langfuse
 * as a trace per item plus scores.
 *
 * Offline: does NOT hit the Quiqup API. Measures LLM tool-call quality
 * against today's MCP tool description, not end-to-end correctness.
 *
 * Env vars (auto-loaded by bun from .env.local):
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *   ANTHROPIC_API_KEY
 *
 * Dry-run: set EVAL_DRY_RUN=1 to print the item count and exit without
 * calling Anthropic or Langfuse. Useful for shape-only sanity checks in CI
 * when API keys aren't available.
 *
 * Run: `bun run eval:fulfilment-orders`
 */

import {
  items,
  type CreateFulfilmentOrderInput,
  type CreateFulfilmentOrderExpected,
} from "./datasets/fulfilment-order-creation-v1";

if (process.env.EVAL_DRY_RUN === "1") {
  console.log(`fulfilment-order-creation-v1 dry-run: ${items.length} items`);
  process.exit(0);
}

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");
const { LangfuseClient } = await import("@langfuse/client");
const { AnthropicInstrumentation } = await import(
  "@arizeai/openinference-instrumentation-anthropic"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const { z } = await import("zod");

const { spec: createFulfilmentOrderSpec } = await import(
  "@/lib/tools/create-fulfilment-order"
);
const { evaluators } = await import("./score-fulfilment-tool-call");

import type { ExperimentTask } from "@langfuse/client";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";

const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new AnthropicInstrumentation()],
});
otelSdk.start();

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

// Mirror the live MCP tool's schema serialisation. As of 2026-05-14 the
// fulfilment spec uses `z.object({}).passthrough()` (wide-open), which means
// the LLM sees an empty parameter list — relying entirely on the description.
// That's a known gap (M4 will tighten the schema); this eval surfaces it.
const inputJsonSchema = z.toJSONSchema(createFulfilmentOrderSpec.inputSchema, {
  target: "draft-07",
  io: "input",
}) as Record<string, unknown>;
const tool = {
  name: createFulfilmentOrderSpec.name,
  description: createFulfilmentOrderSpec.description,
  input_schema: { ...inputJsonSchema, type: "object" as const },
};

interface TaskOutput {
  tool: string | null;
  args: Record<string, unknown> | null;
}

const task: ExperimentTask<
  CreateFulfilmentOrderInput,
  CreateFulfilmentOrderExpected
> = async (item) => {
  const input = (item as { input?: CreateFulfilmentOrderInput }).input;
  if (!input?.request) {
    return { tool: null, args: null } satisfies TaskOutput;
  }
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [tool],
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content:
          "You are a fulfilment operations assistant for a Dubai-based merchant " +
          "using Quiqup's warehouse. Translate the merchant's request into a " +
          "create_fulfilment_order tool call with the right arguments. Use " +
          "sensible defaults for unspecified fields.\n\n" +
          `Request: ${input.request}`,
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
  name: `fulfilment-order-creation-v1 (${MODEL})`,
  description:
    `Offline tool-call quality baseline for create_fulfilment_order on ${MODEL}. ` +
    "6 hand-authored merchant requests scored by tool-name-match, " +
    "required-fields-present (shipping_address/items/service_kind), and args-overlap.",
  data: items,
  task,
  evaluators,
});

console.log(await result.format());

// Drain Langfuse score queue BEFORE OTEL shutdown — same flush ordering as
// lastmile-order-creation.ts, see comment there for the dropped-scores bug.
await langfuse.shutdown();
await otelSdk.shutdown();

// CI gate (opt-in via EVAL_GATE=1; no-op locally).
if (process.env.EVAL_GATE === "1") {
  const { gate } = await import("./gate");
  gate(result, [{ scoreName: "args-overlap", min: 0.85 }]);
}
