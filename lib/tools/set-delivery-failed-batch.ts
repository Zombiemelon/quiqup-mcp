/**
 * `set_delivery_failed_batch` — staging-only QA helper.
 *
 * Marks one or more Last-Mile orders as delivery-failed via
 * PUT /orders/batch/set_delivery_failed. Lifted from the
 * `Quiqup Staging State Change` Postman collection.
 *
 * STAGING ONLY: see header on `set-out-for-delivery-batch.ts` — same
 * rationale. The `environment` arg is pinned via `z.literal("staging")`.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { ENVIRONMENT_DESCRIPTION } from "@/lib/clients/quiqup-env";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

const inputSchema = z.object({
  order_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("Quiqup Last-Mile order IDs (numeric, up to 10 per call)."),
  failure_reason_uid: z
    .string()
    .min(1)
    .describe(
      "Machine-readable failure reason code, e.g. `future_delivery_request`.",
    ),
  failure_reason: z
    .string()
    .min(1)
    .describe(
      "Human-readable failure reason, e.g. \"Future Delivery request\".",
    ),
  idempotency_key: z.string().optional(),
  environment: z
    .literal("staging")
    .default("staging")
    .describe(
      `${ENVIRONMENT_DESCRIPTION} This tool is STAGING-ONLY — any other value is rejected.`,
    ),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "set_delivery_failed_batch",
  description:
    "STAGING-ONLY. Mark one or more Last-Mile orders as `delivery_failed` " +
    "(PUT /orders/batch/set_delivery_failed, up to 10 orders per call). " +
    "Requires both `failure_reason_uid` (machine code) and `failure_reason` " +
    "(human text). Not available against production.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "set_delivery_failed_batch requires an authenticated user",
      );
    }
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupLastmileClient({ jwt, environment: "staging" });
    const data = await client.request("PUT", "/orders/batch/set_delivery_failed", {
      body: {
        order_ids: args.order_ids,
        failure_reason_uid: args.failure_reason_uid,
        failure_reason: args.failure_reason,
      },
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Marked ${args.order_ids.length} order(s) delivery_failed on staging ` +
            `(reason: ${args.failure_reason_uid}).\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
