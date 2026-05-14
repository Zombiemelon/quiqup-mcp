import { describe, it, expect } from "vitest";

describe("remove_parcel_from_order (disabled-pending-M6)", () => {
  const auth = {
    userId: "user_test",
    orgId: null,
    sessionId: "sess_test",
    scopes: ["read"],
    bearerToken: "test-token",
  };

  describe("registration", () => {
    it("exposes a spec with the expected name and input schema", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("remove_parcel_from_order");
      expect(mod.spec.description).toMatch(/parcel|remove|delete/i);
      const ok = mod.spec.inputSchema.safeParse({
        order_id: "order_1",
        parcel_id: "parcel_1",
      });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({ parcel_id: "parcel_1" });
      expect(r.success).toBe(false);
    });

    it("rejects missing parcel_id", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({ order_id: "order_1" });
      expect(r.success).toBe(false);
    });

    it("rejects non-string parcel_id", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "order_1",
        parcel_id: 99,
      });
      expect(r.success).toBe(false);
    });
  });

  describe("disabled handler", () => {
    it("throws an M6-guardrail error when invoked", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      await expect(
        mod.spec.handler(auth, {
          order_id: "order_1",
          parcel_id: "parcel_1",
        }),
      ).rejects.toThrow(/disabled|M6|guardrail/i);
    });
  });
});
