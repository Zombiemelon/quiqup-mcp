/**
 * `set_out_for_delivery_batch` — staging-only QA helper.
 *
 * Moves one or more Last-Mile orders to the "out for delivery" state via
 * PUT /orders/batch/set_out_for_delivery. Lifted from the
 * `Quiqup Staging State Change` Postman collection that the ops team uses
 * to walk an order through its state machine for end-to-end tests.
 *
 * STAGING ONLY: the `environment` arg is pinned to `z.literal("staging")`
 * so the input validator rejects any prod call before the handler runs.
 * State machine writes are not exposed on production because the merchant
 * surface — not this MCP — owns those transitions in real life.
 *
 * Scope check: deliberately skipped. `assertOrderBelongsToUser` hits
 * production (see lib/middleware/scope.ts) and these orders only exist on
 * staging. Upstream JWT auth still gates the call. If staging-aware scope
 * is added later, wire it in here.
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
  name: "set_out_for_delivery_batch",
  description:
    "STAGING-ONLY. Transition one or more Last-Mile orders to `out_for_delivery` " +
    "(PUT /orders/batch/set_out_for_delivery, up to 10 orders per call). " +
    "Used to walk orders through their state machine for end-to-end tests; " +
    "not available against production. Supply an optional `idempotency_key` " +
    "to make retries safe within a 15-minute window.",
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
        "set_out_for_delivery_batch requires an authenticated user",
      );
    }
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupLastmileClient({ jwt, environment: "staging" });
    const data = await client.request("PUT", "/orders/batch/set_out_for_delivery", {
      body: { order_ids: args.order_ids },
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Moved ${args.order_ids.length} order(s) to out_for_delivery on staging.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
