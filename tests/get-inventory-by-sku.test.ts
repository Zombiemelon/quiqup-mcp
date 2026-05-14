import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "test-jwt-for-msw"),
  };
});

const auth = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["read"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

describe("get_inventory_by_sku", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("registration", () => {
    it("registers under the expected name with required input schema", async () => {
      const mod = await import("../lib/tools/get-inventory-by-sku");
      expect(mod.spec.name).toBe("get_inventory_by_sku");
      expect(mod.spec.description).toMatch(/inventory/i);
      expect(mod.spec.inputSchema.safeParse({ sku: "SKU123" }).success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing sku", async () => {
      const mod = await import("../lib/tools/get-inventory-by-sku");
      const result = mod.spec.inputSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(["sku"]);
    });

    it("rejects non-string sku", async () => {
      const mod = await import("../lib/tools/get-inventory-by-sku");
      expect(mod.spec.inputSchema.safeParse({ sku: 123 }).success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns inventory via msw stub", async () => {
      server.use(
        http.get(
          "https://platform-api.quiqup.com/api/fulfilment/inventory/SKU123",
          () => HttpResponse.json({ sku: "SKU123", sellable: 42 }),
        ),
      );
      const mod = await import("../lib/tools/get-inventory-by-sku");
      const result = await mod.spec.handler(auth, { sku: "SKU123" });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("SKU123");
      expect(first.text).toContain("42");
    });
  });
});
