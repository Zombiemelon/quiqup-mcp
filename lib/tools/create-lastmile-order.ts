import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

// TODO(M4): no cassette, no output schema, no error mapping. M3 thin
// pass-through per Slava's hybrid speed call (2026-05-03).
// New orders land in `pending` state; they only dispatch when
// mark_ready_for_collection is called (currently disabled-pending-M6).
// So creating an order via this tool is reversible until ready_for_collection.
const inputSchema = z.object({
  // Minimal known-required surface; the full request body is
  // documented in references/lastmile.md. Passthrough lets callers
  // include items, payment_mode, references, etc. without an exhaustive
  // schema.
}).passthrough();

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_lastmile_order",
  description:
    [
      "Create a new Quiqup Last-Mile order. Lands in `pending` state; does NOT",
      "dispatch until mark_ready_for_collection is called separately.",
      "",
      "All fields below were staging-verified (2026-05-13). The API is lenient",
      "on types and aliases — what's listed is what's known to work.",
      "",
      "REQUIRED top-level:",
      "  kind:           \"partner_same_day\" | \"partner_next_day\" | \"partner_4hr\" | \"partner_return\"",
      "  payment_mode:   \"pre_paid\" | \"paid_on_delivery\"  (the UI emits only these two)",
      "  payment_amount: number  (use 0 when pre_paid; must be > 0 when paid_on_delivery)",
      "  origin:         { contact_name, contact_phone, address: { address1, town, country } }",
      "  destination:    { contact_name, contact_phone, address: { address1, town, country } }",
      "  items:          [{ name, quantity }]  at minimum",
      "",
      "OPTIONAL top-level (include only if relevant):",
      "  partner_order_id: string  — the merchant's own order reference. THIS is where",
      "                    you put external IDs like \"MCP_EVAL_<timestamp>\". Do NOT put",
      "                    strings inside `references` (see warning below).",
      "  service_kind:   same enum as `kind`; harmless to send both (Quiqdash sends both)",
      "  scheduled_for:  ISO datetime string",
      "  required_docs:  [] | [\"customer_identification_photo\"] | [\"otp\"]  — gates extra",
      "                    collection at delivery. Default [] means no extras.",
      "  billing_identifier, source, metadata, notes",
      "",
      "Address shape (origin/destination.address):",
      "  address1:    string (required)",
      "  address2?:   string",
      "  town:        string (required) — emirate-level area, e.g. \"Dubai\", \"Sharjah\"",
      "  city?:       string (optional; usually mirrors town)",
      "  country:     ISO-2 string (\"AE\" or \"SA\" most common; long form \"UAE\" also accepted)",
      "  coordinates?: {lat, lng} object  (e.g. {lat:25.2048, lng:55.2708})",
      "",
      "Item shape:",
      "  name:        string (required)",
      "  quantity:    number (required, >= 1; one parcel per array entry)",
      "  weight?:     number (optional; string \"5.0\" also accepted)",
      "  dimensions?: {length, width, height} in cm",
      "",
      "WARNING — `references` field:",
      "  The `references` array exists but expects OBJECT-shaped entries, NOT strings.",
      "  Putting `[\"MY_REF_123\"]` causes the API to reject the whole request with",
      "  HTTP 400 \"[order] creation build failed\". For merchant references, use the",
      "  top-level `partner_order_id` string instead, and OMIT `references`.",
      "",
      "Payment cross-field rule:",
      "  payment_mode = paid_on_delivery → payment_amount must be > 0",
      "  payment_mode = pre_paid → payment_amount may be 0",
      "",
      "Do NOT pass these (made-up fields that the API silently ignores or rejects):",
      "  cod_amount, cash_on_delivery, fragile, service_type, order_type, weight_kg.",
    ].join("\n"),
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("create_lastmile_order requires an authenticated user");
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupLastmileClient({ jwt });
    const data = await client.request("POST", "/orders", { body: args });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
