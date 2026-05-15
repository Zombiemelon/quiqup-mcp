// Mark a pending Quiqup Last-Mile order ready for collection.
//
// Why this tool is the most-dangerous of the writer set: it transitions
// the order from `pending` (cancellable, free) into the live dispatch
// pipeline. From the moment Quiqup picks up the parcel there is real money
// + SLA on the line — re-dispatching on a naive LLM retry would double-bill
// the merchant and pollute the carrier queue. Reference: lastmile.md
// guardrail-mapping section flags this as "irreversible-ish — guardrailed".
//
// M6 guardrails wired here (matched to the threats this endpoint creates):
//   1. SCOPE — `assertOrderBelongsToUser` confirms the order is visible
//      under the caller's session JWT before the mutating PUT. Without
//      this, a hostile or buggy client supplying another merchant's
//      order_id could trigger dispatch they don't own. Quiqup's gateway
//      would also reject (the JWT wouldn't resolve the order), but
//      surfacing the violation here makes it a clean ScopeViolationError
//      in our audit trail instead of an opaque upstream 404 — and
//      short-circuits BEFORE the side-effect attempt.
//   2. RATE LIMIT — 5 dispatches per user per minute. Tuned low because
//      a runaway LLM loop here is uniquely expensive (each call dispatches
//      a real parcel). Capacity 5 absorbs operator burst when readying
//      multiple sibling orders; the 5/60 ≈ 0.083 refill is the sustained
//      ceiling.
//   3. IDEMPOTENCY — optional `idempotency_key` (15-minute TTL). The
//      ergonomic call-shape is one-shot per logical dispatch, so the key
//      is OPTIONAL: omitted, the handler runs unwrapped. Supplied, a
//      retry inside the warm-instance window returns the cached prior
//      result without re-PUTting to Quiqup. Callers SHOULD supply a stable
//      key per logical dispatch (e.g. their own order reference) so a
//      transport-level retry or LLM resample doesn't double-trigger
//      dispatch. The cache lives in-process — sufficient for the
//      LLM-retry-within-seconds threat model; cross-instance dedup is
//      M7 (Redis-backed cache).
//   4. AUDIT — every call logs a structured record to stdout
//      (`audit:` prefix, JSON). Includes userId, orgId, idempotency_key,
//      redacted args, duration, ok/error. The redactor (pii-redact.ts)
//      pins `order_id` and `idempotency_key` to the global-safe set.
//
// ROUTE REGISTRATION: already imported by app/[transport]/route.ts as
// `markReadyForCollectionSpec`; no changes needed there.

import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { getQuiqupReadyJwt } from "@/lib/quiqup";
import { assertOrderBelongsToUser } from "@/lib/middleware/scope";

const inputSchema = z.object({
  order_id: z
    .string()
    .min(1, "order_id is required")
    .describe(
      "Quiqup Last-Mile order ID (string). Order must be in `pending` state. After this call the order enters dispatch and can no longer be cancelled freely.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      // Make the WHY visible to the LLM via the schema description: this is
      // an irreversible operation, retries without a stable key will cause
      // duplicate dispatch + double-billing.
      "Optional stable key per *logical* dispatch. Supplying it makes retries safe: a second call with the same key + same args (within 15 minutes, same warm instance) returns the cached prior result without re-dispatching the order. Use your own merchant-side reference (e.g. internal order id), NOT a random UUID per attempt — the whole point is that two retries share one key.",
    ),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "mark_ready_for_collection",
  description:
    "Mark a pending Quiqup Last-Mile order ready for collection (PUT /orders/{order_id}/ready_for_collection). WARNING: irreversible — the order enters live dispatch and starts billable carrier work. Cannot be undone via this MCP surface; cancellation after this point requires Quiqup support.",
  inputSchema,
  outputSchema,
  guardrails: {
    // 5 calls / minute / user. Low ceiling because each call dispatches a
    // real parcel; an LLM retry-loop here is uniquely expensive.
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    // 15-minute idempotency window. Key arg is optional; when present the
    // wrapper de-duplicates against the cached result.
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    // Every call audited. Defaults to true under guardrails, set
    // explicitly for clarity at the call site.
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      // Fail closed — write tools must NEVER run without auth, even though
      // the SDK normally enforces this upstream. Defence in depth.
      throw new Error(
        "mark_ready_for_collection requires an authenticated user",
      );
    }

    // 1. SCOPE GUARD. Short-circuit before any mutating call: confirm the
    //    order is visible under this user's session JWT. Throws
    //    ScopeViolationError on upstream 404, which the audit log will
    //    record verbatim instead of an opaque "order not found".
    await assertOrderBelongsToUser(args.order_id, auth.userId);

    // 2. The actual mutation. We exchange a session JWT and PUT to the
    //    ready_for_collection endpoint. The upstream returns the updated
    //    order envelope; we surface id + state back to the LLM so the
    //    caller can confirm the transition.
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupLastmileClient({ jwt });

    // QuiqupHttpError from any non-2xx flows up to the registerTool
    // wrapper, which maps it into a structured isError MCP result via
    // quiqupErrorToToolResult (with field-level hints on 422). We do NOT
    // catch it here — that would short-circuit the wrapper's nicer
    // formatting. See lib/tools/register.ts:quiqupErrorToToolResult.
    const response = (await client.request(
      "PUT",
      `/orders/${encodeURIComponent(args.order_id)}/ready_for_collection`,
    )) as { order?: { id?: number | string; state?: string } } | null;

    // Quiqup's response shape mirrors GET /orders/{id}: `{order: {...}}`.
    // Some deployments have returned 204 No Content on this PUT; we
    // tolerate both so the tool keeps working if the upstream shape
    // shifts back. State is the load-bearing field — it tells the LLM
    // whether the transition actually happened.
    const order = response?.order;
    const newState = order?.state ?? "ready_for_collection";
    const orderIdEcho = order?.id !== undefined ? String(order.id) : args.order_id;

    return {
      content: [
        {
          type: "text" as const,
          text: `Order ${orderIdEcho} is now ${newState}. The order has entered live dispatch and can no longer be cancelled via this MCP surface.`,
        },
      ],
    };
  },
};
