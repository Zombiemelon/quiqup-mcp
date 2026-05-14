/**
 * fulfilment-order-creation-v1 — first eval dataset for create_fulfilment_order.
 *
 * Each item: a natural-language merchant request describing a fulfilment-order
 * intent (inventory pulled from the Quiqup warehouse, packed, dispatched to a
 * UAE customer) + a hand-authored canonical `create_fulfilment_order` tool
 * call. Scored by ../score-fulfilment-tool-call.ts.
 *
 * Tool-side note: the live MCP tool schema is `z.object({}).passthrough()`
 * (see lib/tools/create-fulfilment-order.ts) — i.e. wide-open. Field names
 * here are pulled from docs/quiqup-api/references/endpoints.md (Fulfilment
 * Orders section) and references/quiqdash-create-order.md. The canonical
 * Quiqdash fulfilment payload uses `shipping_address`, `items[].sku`, and
 * `service_kind` — these are the fields a competent LLM ought to emit.
 *
 * Versioning: this file is the baseline. Future variants land as
 * fulfilment-order-creation-v2.ts, etc. — keeping v1 stable for trend
 * comparison. Synthetic data only — no PII.
 */

export interface CreateFulfilmentOrderInput {
  request: string;
}

export interface CreateFulfilmentOrderExpected {
  tool: "create_fulfilment_order";
  args: Record<string, unknown>;
}

export interface CreateFulfilmentOrderItem {
  input: CreateFulfilmentOrderInput;
  expectedOutput: CreateFulfilmentOrderExpected;
}

export const items: CreateFulfilmentOrderItem[] = [
  {
    input: {
      request:
        "Fulfil an order from our Quiqup warehouse stock: ship 2x SKU TSHIRT-BLK-M to " +
        "Aisha Khalid, +971501112222, 12 Marina Walk, Dubai Marina, Dubai, AE. " +
        "Same-day partner service, customer already paid online.",
    },
    expectedOutput: {
      tool: "create_fulfilment_order",
      args: {
        service_kind: "partner_same_day",
        payment_mode: "pre_paid",
        shipping_address: {
          contact_name: "Aisha Khalid",
          contact_phone: "+971501112222",
          address1: "12 Marina Walk",
          town: "Dubai Marina",
          city: "Dubai",
          country_code: "AE",
        },
        items: [{ sku: "TSHIRT-BLK-M", quantity: 2 }],
      },
    },
  },
  {
    input: {
      request:
        "Send 1x SKU PERFUME-50ML and 1x SKU GIFTBOX-S from the warehouse to " +
        "Omar Saleh, +971502223333, Villa 7, Al Wasl Road, Jumeirah, Dubai, UAE. " +
        "Next-day delivery. Cash on delivery, AED 450.",
    },
    expectedOutput: {
      tool: "create_fulfilment_order",
      args: {
        service_kind: "partner_next_day",
        payment_mode: "paid_on_delivery",
        payment_amount: 450,
        shipping_address: {
          contact_name: "Omar Saleh",
          contact_phone: "+971502223333",
          address1: "Villa 7, Al Wasl Road",
          town: "Jumeirah",
          city: "Dubai",
          country_code: "AE",
        },
        items: [
          { sku: "PERFUME-50ML", quantity: 1 },
          { sku: "GIFTBOX-S", quantity: 1 },
        ],
      },
    },
  },
  {
    input: {
      request:
        "Pick and pack 3x SKU SHOE-42-BRN for customer Fatima Al Marri at " +
        "+971503334444, Apt 1502, Khalifa City A, Abu Dhabi, AE. Standard same-day. " +
        "Customer prepaid via Stripe. Our partner order reference is ORD-2026-0514-001.",
    },
    expectedOutput: {
      tool: "create_fulfilment_order",
      args: {
        service_kind: "partner_same_day",
        payment_mode: "pre_paid",
        partner_order_id: "ORD-2026-0514-001",
        shipping_address: {
          contact_name: "Fatima Al Marri",
          contact_phone: "+971503334444",
          address1: "Apt 1502, Khalifa City A",
          town: "Abu Dhabi",
          city: "Abu Dhabi",
          country_code: "AE",
        },
        items: [{ sku: "SHOE-42-BRN", quantity: 3 }],
      },
    },
  },
  {
    input: {
      request:
        "Dispatch 5x SKU BOOK-NOVEL-EN, COD AED 275, to Hassan Yusuf, " +
        "+971504445555, Office 22, Sharjah Industrial Area 4, Sharjah, AE. " +
        "Same-day if possible.",
    },
    expectedOutput: {
      tool: "create_fulfilment_order",
      args: {
        service_kind: "partner_same_day",
        payment_mode: "paid_on_delivery",
        payment_amount: 275,
        shipping_address: {
          contact_name: "Hassan Yusuf",
          contact_phone: "+971504445555",
          address1: "Office 22, Sharjah Industrial Area 4",
          town: "Sharjah",
          city: "Sharjah",
          country_code: "AE",
        },
        items: [{ sku: "BOOK-NOVEL-EN", quantity: 5 }],
      },
    },
  },
  {
    input: {
      request:
        "Urgent 4-hour delivery: 1x SKU LAPTOP-STAND-BLK from warehouse to " +
        "Layla Ahmed, +971505556666, Tower B, JLT Cluster X, Dubai, AE. " +
        "Prepaid.",
    },
    expectedOutput: {
      tool: "create_fulfilment_order",
      args: {
        service_kind: "partner_4hr",
        payment_mode: "pre_paid",
        shipping_address: {
          contact_name: "Layla Ahmed",
          contact_phone: "+971505556666",
          address1: "Tower B, JLT Cluster X",
          town: "Dubai",
          city: "Dubai",
          country_code: "AE",
        },
        items: [{ sku: "LAPTOP-STAND-BLK", quantity: 1 }],
      },
    },
  },
  {
    input: {
      request:
        "Bulk order — fulfil from warehouse stock: 10x SKU CANDLE-LAV, 5x SKU CANDLE-ROSE " +
        "to Mariam Hassan, +971506667777, Building 5 Apt 401, Al Nahda 2, Ajman, AE. " +
        "Next-day service, COD AED 1200.",
    },
    expectedOutput: {
      tool: "create_fulfilment_order",
      args: {
        service_kind: "partner_next_day",
        payment_mode: "paid_on_delivery",
        payment_amount: 1200,
        shipping_address: {
          contact_name: "Mariam Hassan",
          contact_phone: "+971506667777",
          address1: "Building 5 Apt 401, Al Nahda 2",
          town: "Ajman",
          city: "Ajman",
          country_code: "AE",
        },
        items: [
          { sku: "CANDLE-LAV", quantity: 10 },
          { sku: "CANDLE-ROSE", quantity: 5 },
        ],
      },
    },
  },
];
