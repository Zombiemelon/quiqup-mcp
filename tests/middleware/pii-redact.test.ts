import { describe, it, expect } from "vitest";
import { redactArgs, REDACTED } from "@/lib/middleware/pii-redact";

describe("redactArgs", () => {
  describe("Last-Mile write tools", () => {
    it("redacts recipient and sender contact blocks recursively", () => {
      const args = {
        kind: "partner_same_day",
        payment_mode: "pre_paid",
        payment_amount: 0,
        origin: {
          contact_name: "Alice Smith",
          contact_phone: "+971500000000",
          address: { address1: "123 Some Street", town: "Dubai", country: "AE" },
        },
        destination: {
          contact_name: "Bob Jones",
          contact_phone: "+971511111111",
          address: { address1: "Block 4", town: "Sharjah", country: "AE" },
        },
      };
      const out = redactArgs(args, "create_lastmile_order") as Record<
        string,
        unknown
      >;
      expect(out.kind).toBe("partner_same_day");
      expect(out.payment_mode).toBe("pre_paid");
      expect(out.payment_amount).toBe(0);
      // Whole origin / destination keys are in ALWAYS_REDACT_KEYS, so they
      // collapse to "[REDACTED]" without traversing further. That's the
      // point: never even consider the contents.
      expect(out.origin).toBe(REDACTED);
      expect(out.destination).toBe(REDACTED);
    });

    it("redacts parcels array down to length only", () => {
      const args = {
        order_id: "ord_123",
        parcels: [
          { description: "iphone 15", weight: 0.5 },
          { description: "leather wallet", weight: 0.2 },
          { description: "watch", weight: 0.3 },
        ],
      };
      const out = redactArgs(args, "add_parcel_to_order") as Record<
        string,
        unknown
      >;
      expect(out.order_id).toBe("ord_123");
      expect(out.parcels).toEqual({ redacted: true, length: 3 });
    });

    it("redacts unknown keys conservatively on write tools", () => {
      const args = {
        order_id: "ord_123",
        // hypothetical new field — must NOT leak
        custom_secret_field: "supersecret-value",
      };
      const out = redactArgs(args, "update_lastmile_order") as Record<
        string,
        unknown
      >;
      expect(out.order_id).toBe("ord_123");
      expect(out.custom_secret_field).toBe(REDACTED);
    });
  });

  describe("read-only tools", () => {
    it("preserves ids and numeric filters on get_* tools", () => {
      const args = { order_id: "ord_42", page: 2, per_page: 25 };
      const out = redactArgs(args, "get_lastmile_order") as Record<
        string,
        unknown
      >;
      expect(out).toEqual({ order_id: "ord_42", page: 2, per_page: 25 });
    });

    it("preserves filters object structurally and redacts unknown string values", () => {
      const args = {
        page: 1,
        filters: {
          state: "delivered", // safe enum
          partner_order_id: "MERCHANT_REF_1", // safe ref
          search_text: "alice@example.com", // unknown key + string → redact
        },
      };
      const out = redactArgs(args, "recent_orders") as Record<string, unknown>;
      expect(out.page).toBe(1);
      const filters = out.filters as Record<string, unknown>;
      expect(filters.state).toBe("delivered");
      expect(filters.partner_order_id).toBe("MERCHANT_REF_1");
      expect(filters.search_text).toBe(REDACTED);
    });
  });

  describe("structural edge cases", () => {
    it("returns null/undefined/primitives passthrough", () => {
      expect(redactArgs(null, "get_lastmile_order")).toBe(null);
      expect(redactArgs(undefined, "get_lastmile_order")).toBe(undefined);
    });

    it("redacts a bare leaf string (no parent key)", () => {
      expect(redactArgs("PII-string", "create_lastmile_order")).toBe(REDACTED);
    });

    it("file_base64 always redacted (CSV uploads)", () => {
      const args = { file_base64: "aGVsbG8td29ybGQ=", filename: "p.csv" };
      const out = redactArgs(args, "bulk_validate_products") as Record<
        string,
        unknown
      >;
      expect(out.file_base64).toBe(REDACTED);
      expect(out.filename).toBe("p.csv");
    });
  });
});
