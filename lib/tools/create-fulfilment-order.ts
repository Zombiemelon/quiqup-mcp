import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

// Same fix as create_lastmile_order (2026-05-14): wide-open passthrough
// serialises to `{ properties: {} }` and the LLM sees no field hints, so it
// guesses or sends `{}` and the upstream rejects with 422. Fields are
// declared explicitly here so MCP advertises a real JSON Schema to clients.
const shippingAddressSchema = z
  .object({
    contact_name: z.string().min(1),
    contact_phone: z.string().min(1),
    address1: z.string().min(1),
    address2: z.string().optional(),
    town: z.string().min(1),
    city: z.string().optional(),
    country_code: z.string().min(2),
    notes: z.string().optional(),
  })
  .passthrough();

const itemSchema = z
  .object({
    sku: z.string().min(1),
    quantity: z.number().int().min(1),
  })
  .passthrough();

const inputSchema = z
  .object({
    service_kind: z.enum([
      "partner_same_day",
      "partner_next_day",
      "partner_4hr",
      "partner_return",
    ]),
    shipping_address: shippingAddressSchema,
    items: z.array(itemSchema).min(1),
    payment_mode: z.enum(["pre_paid", "paid_on_delivery"]).optional(),
    payment_amount: z.number().optional(),
    partner_order_id: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_fulfilment_order",
  description:
    [
      "Create a Quiqup Fulfilment order on platform-api.quiqup.com — picks SKUs",
      "from the merchant's warehouse stock, packs, and dispatches.",
      "",
      "REQUIRED top-level:",
      "  service_kind:     \"partner_same_day\" | \"partner_next_day\" | \"partner_4hr\" | \"partner_return\"",
      "  shipping_address: { contact_name, contact_phone, address1, town, country_code, ... }",
      "  items:            [{ sku, quantity }]  one entry per SKU",
      "",
      "OPTIONAL:",
      "  payment_mode:     \"pre_paid\" | \"paid_on_delivery\"",
      "  payment_amount:   number — required > 0 when payment_mode = paid_on_delivery",
      "  partner_order_id: string — merchant's own order reference",
      "  notes:            string",
      "",
      "shipping_address shape:",
      "  contact_name:  string (required)",
      "  contact_phone: string (required, E.164 like \"+9715...\")",
      "  address1:      string (required)",
      "  address2?:     string",
      "  town:          string (required) — emirate-level area, e.g. \"Dubai Marina\"",
      "  city?:         string (e.g. \"Dubai\", \"Abu Dhabi\")",
      "  country_code:  ISO-2 (\"AE\")",
      "",
      "See docs/quiqup-api/references/endpoints.md and quiqdash-create-order.md.",
    ].join("\n"),
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("create_fulfilment_order requires an authenticated user");
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupFulfilmentClient({ jwt });
    const data = await client.request("POST", "/api/fulfilment/orders", { body: args });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
