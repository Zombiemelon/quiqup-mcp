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

describe("get_fulfilment_order", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("registration", () => {
    it("registers under the expected name with required input schema", async () => {
      const mod = await import("../lib/tools/get-fulfilment-order");
      expect(mod.spec.name).toBe("get_fulfilment_order");
      expect(mod.spec.description).toMatch(/order/i);
      expect(mod.spec.inputSchema.safeParse({ order_id: "o1" }).success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/get-fulfilment-order");
      const result = mod.spec.inputSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(["order_id"]);
    });

    it("rejects non-string order_id", async () => {
      const mod = await import("../lib/tools/get-fulfilment-order");
      expect(mod.spec.inputSchema.safeParse({ order_id: 1 }).success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns fulfilment order detail", async () => {
      server.use(
        http.get(
          "https://platform-api.quiqup.com/api/fulfilment/orders/o1",
          () => HttpResponse.json({ id: "o1", state: "order-marker-q" }),
        ),
      );
      const mod = await import("../lib/tools/get-fulfilment-order");
      const result = await mod.spec.handler(auth, { order_id: "o1" });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("order-marker-q");
    });
  });
});
