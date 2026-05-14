/**
 * lastmile-cancel-roundtrip-v1 — ONLINE create + cancel round-trip dataset.
 *
 * Each item drives a two-turn conversation:
 *   1) Claude is asked to CREATE a TEST last-mile order.
 *   2) After the create completes, Claude is asked to CANCEL the order it
 *      just made, with the order_id surfaced in the prompt.
 *
 * The runner hits the real Quiqup staging API (`api.staging.quiqup.com`) on
 * both turns and scores: create-2xx, cancel-via-batch-tool, cancel-2xx.
 *
 * Synthetic test data only — addresses, names, and phone numbers are all
 * "Test ..." placeholders so no real PII or production routes are touched.
 * Each item must include a unique-ish partner_order_id prefix instruction so
 * that two reruns don't collide on the staging side.
 *
 * Three items — keeps the staging blast small while still exercising
 * variation across payment mode and service kind.
 */

export interface CancelRoundtripInput {
  request: string;
}

export interface CancelRoundtripExpected {
  tool: "create_lastmile_order";
}

export interface CancelRoundtripItem {
  input: CancelRoundtripInput;
  expectedOutput: CancelRoundtripExpected;
}

export const items: CancelRoundtripItem[] = [
  {
    input: {
      request:
        "Create a same-day pre-paid TEST delivery. Pickup at Test Street 1, Test Area, Dubai " +
        "(contact: Test Merchant, +971500000000). Drop at Test Building, Test Street 2, Test Area, Dubai " +
        "(contact: Test Customer, +971500000001). One small parcel named \"MCP cancel-rt probe A\". " +
        "Set partner_order_id to a unique string starting with \"MCP_CANCEL_RT_A_\" followed by a timestamp.",
    },
    expectedOutput: { tool: "create_lastmile_order" },
  },
  {
    input: {
      request:
        "Create a next-day paid-on-delivery TEST order, AED 100 to collect. " +
        "Pickup at Test Warehouse, Test Industrial Area 3, Sharjah (contact: Test Sender, +971500000010). " +
        "Drop at Test Apartment 5, Test Tower, Abu Dhabi (contact: Test Recipient, +971500000011). " +
        "One parcel named \"MCP cancel-rt probe B\", 2kg. " +
        "Set partner_order_id to a unique string starting with \"MCP_CANCEL_RT_B_\" followed by a timestamp.",
    },
    expectedOutput: { tool: "create_lastmile_order" },
  },
  {
    input: {
      request:
        "Create a 4-hour pre-paid TEST delivery. Pickup at Test Plaza, Test Boulevard, Dubai " +
        "(contact: Test Origin, +971500000020). Drop at Test Villa 12, Test Compound, Dubai " +
        "(contact: Test Dest, +971500000021). Two small parcels, each named \"MCP cancel-rt probe C\". " +
        "Set partner_order_id to a unique string starting with \"MCP_CANCEL_RT_C_\" followed by a timestamp.",
    },
    expectedOutput: { tool: "create_lastmile_order" },
  },
];
