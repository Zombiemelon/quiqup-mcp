import { describe, it, expect } from "vitest";

describe("adjust_stock (disabled-pending-M6)", () => {
  describe("registration", () => {
    it("exposes a spec with the expected name and required input schema", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("adjust_stock");
      expect(mod.spec.description).toMatch(/stock|inventory|adjust/i);
      const ok = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: -1,
        reason: "audit correction",
      });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing sku", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        bucket: "sellable",
        delta: 1,
        reason: "x",
      });
      expect(r.success).toBe(false);
    });

    it("rejects missing bucket", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        delta: 1,
        reason: "x",
      });
      expect(r.success).toBe(false);
    });

    it("rejects missing reason", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: 1,
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-numeric delta", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: "1",
        reason: "x",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("disabled handler", () => {
    it("throws an M6-guardrail error when invoked", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const auth = {
        userId: "user_test",
        orgId: null,
        sessionId: "sess_test",
        scopes: ["read"],
        bearerToken: "test-token",
      };
      await expect(
        mod.spec.handler(auth, {
          sku: "SKU-1",
          bucket: "sellable",
          delta: -1,
          reason: "audit correction",
        }),
      ).rejects.toThrow(/disabled|M6|guardrail/i);
    });
  });
});
