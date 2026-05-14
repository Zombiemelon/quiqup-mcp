import { describe, it, expect } from "vitest";

describe("cancel_lastmile_orders_batch (disabled-pending-M6)", () => {
  describe("registration", () => {
    it("exposes a spec with the expected name and input schema", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("cancel_lastmile_orders_batch");
      expect(mod.spec.description).toMatch(/cancel/i);
      const ok = mod.spec.inputSchema.safeParse({ order_ids: ["123", "456"] });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_ids", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it("rejects empty order_ids array", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({ order_ids: [] });
      expect(r.success).toBe(false);
    });

    it("rejects non-array order_ids", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({ order_ids: "123" });
      expect(r.success).toBe(false);
    });

    it("rejects more than 10 order_ids", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({
        order_ids: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
      });
      expect(r.success).toBe(false);
    });

    it("rejects empty-string entries", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({ order_ids: [""] });
      expect(r.success).toBe(false);
    });
  });

  describe("disabled handler", () => {
    it("throws an M6-guardrail error when invoked", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const auth = {
        userId: "user_test",
        orgId: null,
        sessionId: "sess_test",
        scopes: ["read"],
        bearerToken: "test-token",
      };
      await expect(
        mod.spec.handler(auth, { order_ids: ["123"] }),
      ).rejects.toThrow(/disabled|M6|guardrail/i);
    });
  });
});
