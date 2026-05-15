import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { getQuiqupReadyJwt } from "@/lib/quiqup";
import { assertOrderBelongsToUser } from "@/lib/middleware/scope";

// Per references/lastmile.md: DELETE — guardrailed. Cannot remove the last
// parcel (Quiqup state-machine enforces this and returns 422). Per skill
// SKILL.md guardrails: any DELETE is dangerous, so this tool is M6-wired
// with multi-tenant scope check, idempotency cache, rate limit, and audit.

const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  parcel_id: z.string().min(1, "parcel_id is required"),
  // Optional idempotency key. When supplied, registerTool's middleware
  // caches the handler result for 15 minutes keyed by
  // `{userId, tool, idempotency_key}` so an LLM retry doesn't hit the
  // upstream DELETE twice. Absent = single-shot, no caching.
  idempotency_key: z.string().optional(),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "remove_parcel_from_order",
  description:
    "Remove a parcel from a Quiqup Last-Mile order (DELETE /orders/{order_id}/parcels/{parcel_id}). Note: cannot remove the last parcel of an order — Quiqup rejects that with HTTP 422.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId)
      throw new Error("remove_parcel_from_order requires an authenticated user");

    // Scope-check the order_id under this user's session JWT before any
    // mutation. Surfaces foreign-resource attempts as ScopeViolationError
    // (audit-tagged) instead of letting them flow through to the upstream
    // DELETE as an opaque 404 trace.
    await assertOrderBelongsToUser(args.order_id, auth.userId);

    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupLastmileClient({ jwt });
    const data = await client.request(
      "DELETE",
      `/orders/${encodeURIComponent(args.order_id)}/parcels/${encodeURIComponent(args.parcel_id)}`,
    );

    // Quiqup's DELETE may return either the updated order body (200 + JSON
    // with an `items` array — each item is one parcel) or a 204 No Content
    // depending on the surface. Surface a useful confirmation either way.
    let remaining: number | null = null;
    if (data && typeof data === "object") {
      const order = (data as { order?: { items?: unknown[] } }).order;
      if (order && Array.isArray(order.items)) {
        remaining = order.items.length;
      } else if (Array.isArray((data as { items?: unknown[] }).items)) {
        remaining = (data as { items: unknown[] }).items.length;
      }
    }

    const summary =
      remaining !== null
        ? `Removed parcel ${args.parcel_id} from order ${args.order_id}. ${remaining} parcel(s) remaining.`
        : `Removed parcel ${args.parcel_id} from order ${args.order_id}.`;

    const body =
      data === null
        ? summary
        : `${summary}\n\nUpstream response:\n${JSON.stringify(data, null, 2)}`;

    return {
      content: [{ type: "text" as const, text: body }],
    };
  },
};
