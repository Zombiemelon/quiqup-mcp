import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { ScopeViolationError } from "@/lib/middleware/scope";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

// Per references/endpoints.md + skill SKILL.md: booking moves real warehouse
// capacity. Slot is a finite resource — overbooking has cascade effects on
// other merchants. M6 guardrails wired: ownership check (scope), tight
// rate-limit (3/min), idempotency (15 min TTL), audit.

const inputSchema = z
  .object({
    inbound_id: z.string().min(1, "inbound_id is required"),
    slot_id: z.string().min(1, "slot_id is required (from list_inbound_slots)"),
    idempotency_key: z.string().optional(),
  })
  .passthrough();

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "book_inbound_slot",
  description:
    "Book an inbound delivery slot at a Quiqup warehouse for a given inbound delivery. Booking consumes real warehouse capacity; overbooking has cascade effects on other merchants. Use list_inbound_slots to see availability first, and supply an idempotency_key to make retries safe (double-booking wastes the slot).",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 }, // 3 bookings/min
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("book_inbound_slot requires an authenticated user");
    }
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupFulfilmentClient({ jwt });

    // TODO(M7): promote to a typed helper in scope.ts when a third tool needs it.
    // Ownership check — confirm the inbound is visible to this caller's JWT.
    // A 404 here means the inbound either doesn't exist or belongs to a
    // different tenant; either way, refuse to attempt the booking.
    try {
      await client.request(
        "GET",
        `/api/fulfilment/inbounds/${encodeURIComponent(args.inbound_id)}`,
      );
    } catch (err) {
      if (err instanceof QuiqupHttpError && err.status === 404) {
        throw new ScopeViolationError("inbound", args.inbound_id, auth.userId);
      }
      throw err;
    }

    // Book the slot. Upstream conflict/validation errors (409, 422) propagate
    // as QuiqupHttpError, which the registerTool wrapper renders for the LLM.
    const body = (await client.request(
      "POST",
      `/api/fulfilment/inbounds/${encodeURIComponent(args.inbound_id)}/book_slot`,
      { body: { slot_id: args.slot_id } },
    )) as Record<string, unknown> | null;

    // Surface booked slot id + any capacity hint the upstream returned, so
    // the LLM can confirm the booking without a follow-up GET. We keep this
    // best-effort — different upstream responses use different field names
    // (capacity_remaining, remaining_capacity, available_capacity).
    const bookedSlotId =
      (body && typeof body === "object" && "slot_id" in body
        ? String((body as Record<string, unknown>).slot_id)
        : args.slot_id) ?? args.slot_id;
    const capacityRemaining =
      body && typeof body === "object"
        ? ((body as Record<string, unknown>).capacity_remaining ??
          (body as Record<string, unknown>).remaining_capacity ??
          (body as Record<string, unknown>).available_capacity)
        : undefined;

    const summary =
      capacityRemaining !== undefined
        ? `Booked slot ${bookedSlotId} for inbound ${args.inbound_id}. Capacity remaining: ${String(capacityRemaining)}.`
        : `Booked slot ${bookedSlotId} for inbound ${args.inbound_id}.`;

    return {
      content: [
        { type: "text" as const, text: summary },
        {
          type: "text" as const,
          text: JSON.stringify(body ?? { slot_id: args.slot_id }, null, 2),
        },
      ],
    };
  },
};
