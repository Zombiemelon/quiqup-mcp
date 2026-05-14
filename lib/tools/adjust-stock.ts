import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { assertSkuBelongsToUser } from "@/lib/middleware/scope";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

// Per skill SKILL.md guardrails: stock adjustments are always sensitive,
// regardless of sign or magnitude. Zeroing out a real merchant's inventory
// or even small accidental deltas materially affect dispatch + billing, so
// this tool layers multiple guardrails:
//   - scope: assertSkuBelongsToUser short-circuits 404-on-foreign-tenant
//     BEFORE the POST, so a hostile/buggy caller can't mutate other
//     merchants' inventory.
//   - rate-limit: tightest of the seven write tools (5/min). An LLM in
//     retry loop here is the worst-case scenario.
//   - idempotency: caller-supplied key dedupes near-duplicate replays
//     inside the 15-min window so an LLM retry doesn't double-apply a delta.
//   - audit: every call (success or denial) is recorded for forensics.
//   - zero-delta confirm: delta=0 is a no-op that's almost certainly a
//     mistake (e.g. LLM omitted the actual quantity). We surface it as a
//     structured isError unless the caller explicitly opts in via
//     `confirm_zero: true`.

const inputSchema = z.object({
  sku: z.string().min(1, "sku is required"),
  bucket: z.string().min(1, "bucket is required (e.g. sellable, damaged, reserved)"),
  delta: z
    .number()
    .int("delta must be an integer (whole units, positive or negative)")
    .describe(
      "Signed integer change to apply to the bucket. Positive adds stock, negative removes. " +
        "Zero is treated as a likely mistake and rejected unless `confirm_zero: true` is also " +
        "set — pass that flag only when intentionally re-asserting a no-op (e.g. a sync probe).",
    ),
  reason: z.string().min(1, "reason is required for audit"),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied dedupe key. Replays of the same key+args within 15 minutes " +
        "return the cached prior result instead of re-applying the adjustment.",
    ),
  confirm_zero: z
    .boolean()
    .optional()
    .describe(
      "Required to be `true` when `delta` is 0 — guards against the common LLM mistake of " +
        "omitting the actual quantity. Ignored when delta is non-zero.",
    ),
}).passthrough();

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "adjust_stock",
  description:
    "Adjust stock levels for a Quiqup Fulfilment SKU + bucket (POST /api/fulfilment/inventory/adjustments). " +
    "Inventory writes are ALWAYS sensitive, including zeros and small deltas — a mis-applied " +
    "adjustment can zero out a merchant's sellable stock or double-bill on damaged-bucket reconciliation. " +
    "Required: sku, bucket, integer delta, reason. Optional: idempotency_key (recommended for replay " +
    "safety), confirm_zero (mandatory when delta=0).",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 }, // 5 adjustments/min
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("adjust_stock requires an authenticated user");

    // Zero-delta confirm: surface as structured isError (not a thrown
    // exception) so the LLM caller sees a clear, recoverable message
    // instead of a generic RPC failure. Short-circuits BEFORE the scope
    // GET — no upstream traffic at all on a zero-without-confirm call.
    if (args.delta === 0 && args.confirm_zero !== true) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "delta=0 is a no-op and is almost certainly a mistake (did you forget to " +
              "supply the actual quantity?). If you genuinely intend to re-assert the " +
              "current stock value, re-call with `confirm_zero: true`.",
          },
        ],
        isError: true,
      };
    }

    // Scope: confirm the SKU is visible under this user's Quiqup session.
    // Throws ScopeViolationError on 404; the SDK surfaces that as a
    // JSON-RPC error and the audit layer records the violation.
    await assertSkuBelongsToUser(args.sku, auth.userId);

    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupFulfilmentClient({ jwt });
    // Forward the full args body — the upstream contract takes sku/bucket/
    // delta/reason and may accept additional fields (the schema is
    // passthrough-permissive). Strip our local-only flags so they don't
    // leak upstream and so cassettes diff cleanly.
    const { idempotency_key: _ik, confirm_zero: _cz, ...upstreamBody } = args;
    void _ik;
    void _cz;
    const data = (await client.request(
      "POST",
      `/api/fulfilment/inventory/adjustments`,
      { body: upstreamBody },
    )) as
      | {
          sku?: string;
          bucket?: string;
          before?: number;
          after?: number;
          delta?: number;
        }
      | null;

    const before = data?.before;
    const after = data?.after;
    const appliedDelta = data?.delta ?? args.delta;
    const summary =
      `Stock adjustment applied for sku=${args.sku} bucket=${args.bucket}: ` +
      `delta=${appliedDelta}` +
      (typeof before === "number" && typeof after === "number"
        ? ` (before=${before}, after=${after})`
        : "");

    return {
      content: [
        { type: "text" as const, text: summary },
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  },
};
