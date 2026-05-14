import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { getQuiqupReadyJwt } from "@/lib/quiqup";
import {
  assertOrderBelongsToUser,
  ScopeViolationError,
} from "@/lib/middleware/scope";

// Per references/lastmile.md: cancellation + batch.
// Upstream contract (validated by evals/lastmile-order-roundtrip.ts):
//   PUT /orders/batch/set_cancelled  body: { order_ids: [<id>, …] }
// Max 10 orders per call — enforced in the input schema below.
//
// M6 guardrails:
//   - per-order scope assertion (assertOrderBelongsToUser) BEFORE the
//     destructive PUT. Any 404 from the per-id GET → refuse the whole
//     batch, name the denied ids, leave no upstream PUT trace.
//   - idempotency keyed on caller-supplied `idempotency_key` (15-min TTL).
//   - tight rate-limit: 3 batches / minute (batch cancels should be rare).
//   - audit log on every call.

const inputSchema = z.object({
  order_ids: z.array(z.string().min(1)).min(1).max(10),
  idempotency_key: z.string().optional(),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "cancel_lastmile_orders_batch",
  description:
    "Cancel one or more pending Quiqup Last-Mile orders in a single batch (up to 10 orders per call). Each order is scope-checked under the caller's session before the batch PUT runs; if any order is not visible to the caller the whole batch is refused. Supply an optional `idempotency_key` to make retries safe within a 15-minute window.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 }, // tight: 3 batches/min
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "cancel_lastmile_orders_batch requires an authenticated user",
      );
    }

    // 1. Per-id scope assertion. Collect denials rather than throwing on the
    //    first one so the error message can name every offending id at once
    //    (the LLM caller can then drop the bad ids and retry without a
    //    binary-search dance).
    const denied: string[] = [];
    for (const id of args.order_ids) {
      try {
        await assertOrderBelongsToUser(id, auth.userId);
      } catch (err) {
        if (err instanceof ScopeViolationError) {
          denied.push(id);
        } else {
          throw err;
        }
      }
    }
    if (denied.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Batch cancel refused: ${denied.length} order id(s) not visible ` +
              `under your session: ${denied.join(", ")}. No upstream cancel was ` +
              `attempted. Drop the inaccessible id(s) and retry.`,
          },
        ],
        isError: true,
      };
    }

    // 2. All ids in scope — fire the batch PUT.
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupLastmileClient({ jwt });
    const data = await client.request("PUT", "/orders/batch/set_cancelled", {
      body: { order_ids: args.order_ids },
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Cancelled ${args.order_ids.length} order(s).\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
