import { describe, it, expect } from "vitest";

describe("book_inbound_slot (disabled-pending-M6)", () => {
  const auth = {
    userId: "user_test",
    orgId: null,
    sessionId: "sess_test",
    scopes: ["read"],
    bearerToken: "test-token",
  };

  describe("registration", () => {
    it("exposes a spec with the expected name and input schema", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("book_inbound_slot");
      expect(mod.spec.description).toMatch(/inbound|slot|warehouse/i);
      const ok = mod.spec.inputSchema.safeParse({ slot_id: "slot_123" });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing slot_id", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      const r = mod.spec.inputSchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it("rejects empty-string slot_id", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      const r = mod.spec.inputSchema.safeParse({ slot_id: "" });
      expect(r.success).toBe(false);
    });

    it("rejects non-string slot_id", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      const r = mod.spec.inputSchema.safeParse({ slot_id: 42 });
      expect(r.success).toBe(false);
    });
  });

  describe("disabled handler", () => {
    it("throws an M6-guardrail error when invoked", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      await expect(
        mod.spec.handler(auth, { slot_id: "slot_123" }),
      ).rejects.toThrow(/disabled|M6|guardrail/i);
    });
  });
});
