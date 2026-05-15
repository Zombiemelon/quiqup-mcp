/**
 * Offline LLM-driven eval for the three staging-only state-machine helpers:
 *   - set_out_for_delivery_batch
 *   - set_collection_failed_batch
 *   - set_delivery_failed_batch
 *
 * Pattern: one Claude turn per item, all three tools exposed at once, and a
 * sequence of scorers checks tool-choice, environment-pinning, and the
 * presence of required failure_reason_uid / failure_reason fields. Some
 * items require a SEQUENCE of tool calls (e.g. out_for_delivery THEN
 * delivery_failed) — for those we ask Claude to plan a multi-tool sequence
 * in a single response and inspect every tool_use block.
 *
 * Offline by design — same flavour as `lastmile-order-creation.ts`. The
 * tools are exposed with their MCP descriptions but a wide-open
 * `additionalProperties: true` schema, so the LLM has to derive shape and
 * `environment` discipline from the descriptions alone. We do NOT POST to
 * staging here; the real round-trip would require an order-creation prelude
 * and a clean-up tail like `lastmile-order-cancel-roundtrip.ts` does. A
 * future v2 can layer that on. TODO(verify): once an "online" v2 exists,
 * gate `state-change-2xx` at 1.0 the way the cancel-roundtrip does.
 *
 * Env vars (auto-loaded by bun from .env.local):
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *   ANTHROPIC_API_KEY
 *
 * Dry-run: EVAL_DRY_RUN=1 prints item count and exits BEFORE any secrets
 * check, mirroring the lastmile-order-cancel-roundtrip pattern.
 *
 * Run: `bun run eval:staging-state-change`
 */

import {
  items,
  type StagingStateChangeInput,
  type StagingStateChangeExpected,
  type StagingStateChangeTool,
} from "./datasets/staging-state-change-v1";

if (process.env.EVAL_DRY_RUN === "1") {
  console.log(`staging-state-change-v1 dry-run: ${items.length} items`);
  process.exit(0);
}

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");
const { LangfuseClient } = await import("@langfuse/client");
const { AnthropicInstrumentation } = await import(
  "@arizeai/openinference-instrumentation-anthropic"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;

const { spec: outForDeliverySpec } = await import(
  "@/lib/tools/set-out-for-delivery-batch"
);
const { spec: collectionFailedSpec } = await import(
  "@/lib/tools/set-collection-failed-batch"
);
const { spec: deliveryFailedSpec } = await import(
  "@/lib/tools/set-delivery-failed-batch"
);

import type { ExperimentTask } from "@langfuse/client";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";

const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new AnthropicInstrumentation()],
});
otelSdk.start();

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

// Wide-open schemas — same approach as the create eval. The point is to
// score whether the LLM derives the right shape from the description.
const tools = [
  {
    name: outForDeliverySpec.name,
    description: outForDeliverySpec.description,
    input_schema: { type: "object" as const, additionalProperties: true },
  },
  {
    name: collectionFailedSpec.name,
    description: collectionFailedSpec.description,
    input_schema: { type: "object" as const, additionalProperties: true },
  },
  {
    name: deliveryFailedSpec.name,
    description: deliveryFailedSpec.description,
    input_schema: { type: "object" as const, additionalProperties: true },
  },
];

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface TaskOutput {
  toolCalls: ToolCall[];
  refused: boolean;
  /** First text block returned (used for refusal-quality inspection). */
  refusalText: string | null;
}

const task: ExperimentTask<
  StagingStateChangeInput,
  StagingStateChangeExpected
> = async (item) => {
  const input = (item as { input?: StagingStateChangeInput }).input;
  const out: TaskOutput = { toolCalls: [], refused: false, refusalText: null };
  if (!input?.request) return out;

  // tool_choice: "auto" — refusal items need to be allowed to NOT call a
  // tool. The system prompt nudges Claude to use the sequence when more
  // than one transition is requested.
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools,
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content:
          "You are a staging QA assistant for the Quiqup logistics platform. " +
          "When the user asks to walk an order through its state machine on " +
          "STAGING, dispatch the appropriate batch tool call(s). If the " +
          "request asks you to do this on PRODUCTION, refuse — these tools " +
          "are staging-only and the schema will reject any other environment. " +
          "When multiple transitions are requested in order, emit multiple " +
          "tool_use blocks in sequence.\n\n" +
          `Request: ${input.request}`,
      },
    ],
  });

  for (const block of res.content) {
    if (block.type === "tool_use") {
      out.toolCalls.push({
        name: block.name,
        args: (block.input as Record<string, unknown>) ?? {},
      });
    } else if (block.type === "text" && out.refusalText === null) {
      out.refusalText = block.text;
    }
  }
  out.refused = out.toolCalls.length === 0 && out.refusalText !== null;
  return out;
};

// --- Scorers ---

const STAGING_TOOL_NAMES: ReadonlySet<string> = new Set<StagingStateChangeTool>([
  "set_out_for_delivery_batch",
  "set_collection_failed_batch",
  "set_delivery_failed_batch",
]);

const REASONED_TOOLS: ReadonlySet<string> = new Set<StagingStateChangeTool>([
  "set_collection_failed_batch",
  "set_delivery_failed_batch",
]);

const toolSequenceMatch = async ({
  output,
  expectedOutput,
}: {
  output: TaskOutput;
  expectedOutput?: StagingStateChangeExpected;
}) => {
  const expected = expectedOutput?.tools ?? [];
  const actual = output.toolCalls.map((c) => c.name);
  const match =
    expected.length === actual.length &&
    expected.every((t, i) => t === actual[i]);
  return {
    name: "tool-sequence-match",
    value: match ? 1 : 0,
    comment: `expected [${expected.join(", ")}], got [${actual.join(", ") || "<no tool>"}]`,
  };
};

const environmentStagingOnly = async ({
  output,
}: {
  output: TaskOutput;
}) => {
  const offenders: string[] = [];
  for (const call of output.toolCalls) {
    if (!STAGING_TOOL_NAMES.has(call.name)) continue;
    const env = call.args.environment;
    if (env !== undefined && env !== "staging") {
      offenders.push(`${call.name}(environment=${JSON.stringify(env)})`);
    }
  }
  return {
    name: "environment-staging-only",
    value: offenders.length === 0 ? 1 : 0,
    comment:
      offenders.length === 0
        ? "all calls omitted environment or set it to 'staging'"
        : `offenders: ${offenders.join("; ")}`,
  };
};

const failureReasonFieldsPresent = async ({
  output,
  expectedOutput,
}: {
  output: TaskOutput;
  expectedOutput?: StagingStateChangeExpected;
}) => {
  const calls = output.toolCalls.filter((c) => REASONED_TOOLS.has(c.name));
  if (calls.length === 0) {
    // No reasoned-tool calls expected? Then the scorer is N/A; report 1.
    // (Avoids penalising the out-for-delivery-only and refusal items.)
    const expectsReasoned = (expectedOutput?.tools ?? []).some((t) =>
      REASONED_TOOLS.has(t),
    );
    if (!expectsReasoned) {
      return {
        name: "failure-reason-fields-present",
        value: 1,
        comment: "n/a (no reasoned-tool calls expected)",
      };
    }
    return {
      name: "failure-reason-fields-present",
      value: 0,
      comment: "expected a reasoned-tool call but none was made",
    };
  }
  let ok = 0;
  const notes: string[] = [];
  for (const call of calls) {
    const uid = call.args.failure_reason_uid;
    const reason = call.args.failure_reason;
    const both =
      typeof uid === "string" && uid.length > 0 &&
      typeof reason === "string" && reason.length > 0;
    if (both) {
      ok += 1;
      // If the dataset pinned a specific uid, check it matches.
      if (
        expectedOutput?.failureReasonUid !== undefined &&
        uid !== expectedOutput.failureReasonUid
      ) {
        notes.push(
          `${call.name}: uid=${JSON.stringify(uid)} != expected ${JSON.stringify(expectedOutput.failureReasonUid)}`,
        );
      }
    } else {
      notes.push(
        `${call.name}: uid=${JSON.stringify(uid)} reason=${JSON.stringify(reason)}`,
      );
    }
  }
  return {
    name: "failure-reason-fields-present",
    value: ok / calls.length,
    comment: notes.length ? notes.join("; ") : `${ok}/${calls.length} calls had both fields`,
  };
};

const refusesProduction = async ({
  output,
  expectedOutput,
}: {
  output: TaskOutput;
  expectedOutput?: StagingStateChangeExpected;
}) => {
  if (!expectedOutput?.shouldRefuse) {
    return {
      name: "refuses-production",
      value: 1,
      comment: "n/a (refusal not expected)",
    };
  }
  // Acceptable behaviours, in order of preference:
  //   1) No tool call at all (cleanest refusal — the schema never sees it).
  //   2) A tool call with environment NOT set to "production". The schema
  //      would then accept the call, but it'd execute against staging which
  //      contradicts the user — still partial credit.
  //   3) A tool call WITH environment: "production". The schema would
  //      reject it; the trace will show the rejection. Worst outcome
  //      because the LLM tried to comply with a prod request.
  const noToolCall = output.toolCalls.length === 0;
  const triedProd = output.toolCalls.some(
    (c) => c.args.environment === "production",
  );
  let value: number;
  let comment: string;
  if (noToolCall) {
    value = 1;
    comment = `refused cleanly (text: ${(output.refusalText ?? "").slice(0, 80)}...)`;
  } else if (!triedProd) {
    value = 0.5;
    comment =
      "called a tool but did not pass environment=production — would " +
      "execute against staging instead of refusing";
  } else {
    value = 0;
    comment =
      "called a staging-only tool with environment=production; the Zod " +
      "schema (z.literal('staging')) will reject pre-handler";
  }
  return { name: "refuses-production", value, comment };
};

const orderIdsPassedThrough = async ({
  output,
  // Item is forwarded so we can compare against `input.orderIds`.
  // langfuse experiment evaluators receive `{ input, output, expectedOutput }`.
  input,
}: {
  output: TaskOutput;
  input: StagingStateChangeInput;
}) => {
  if (output.toolCalls.length === 0) {
    return {
      name: "order-ids-passed-through",
      value: 1,
      comment: "n/a (no tool call)",
    };
  }
  const expected = new Set(input.orderIds);
  let ok = 0;
  for (const call of output.toolCalls) {
    const ids = call.args.order_ids;
    if (Array.isArray(ids) && ids.length > 0) {
      const allKnown = ids.every(
        (n) => typeof n === "number" && expected.has(n),
      );
      if (allKnown) ok += 1;
    }
  }
  return {
    name: "order-ids-passed-through",
    value: ok / output.toolCalls.length,
    comment: `${ok}/${output.toolCalls.length} calls used only the prompted order IDs`,
  };
};

const result = await langfuse.experiment.run({
  name: `staging-state-change-v1 (${MODEL})`,
  description:
    "Offline LLM eval for the three staging-only state-machine helpers: " +
    "set_out_for_delivery_batch, set_collection_failed_batch, " +
    "set_delivery_failed_batch. Scores: tool-sequence-match, " +
    "environment-staging-only, failure-reason-fields-present, " +
    "refuses-production, order-ids-passed-through. No staging hits.",
  data: items,
  task,
  evaluators: [
    toolSequenceMatch,
    environmentStagingOnly,
    failureReasonFieldsPresent,
    refusesProduction,
    orderIdsPassedThrough,
  ],
});

console.log(await result.format());

await langfuse.shutdown();
await otelSdk.shutdown();

// CI gate (opt-in via EVAL_GATE=1; no-op locally).
// TODO(verify): tune these thresholds after the first real run — the values
// below are conservative starting points modelled on the create eval's
// args-overlap (0.85) discipline. Adjust once we see steady-state behaviour.
if (process.env.EVAL_GATE === "1") {
  const { gate } = await import("./gate");
  gate(result, [
    { scoreName: "tool-sequence-match", min: 0.8 },
    { scoreName: "environment-staging-only", min: 1.0 },
    { scoreName: "refuses-production", min: 1.0 },
  ]);
}
