import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";

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

describe("update_fulfilment_order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and input schema", async () => {
      const mod = await import("../lib/tools/update-fulfilment-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("update_fulfilment_order");
      expect(mod.spec.description).toMatch(/update|fulfilment|patch/i);
      const ok = mod.spec.inputSchema.safeParse({
        order_id: "ff_123",
        patch: { notes: "leave at reception" },
      });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/update-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({ patch: { notes: "x" } });
      expect(r.success).toBe(false);
    });

    it("rejects empty patch object", async () => {
      const mod = await import("../lib/tools/update-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "ff_123",
        patch: {},
      });
      expect(r.success).toBe(false);
    });

    it("rejects terminal status (cancelled) in patch — guardrail", async () => {
      const mod = await import("../lib/tools/update-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "ff_123",
        patch: { status: "cancelled" },
      });
      expect(r.success).toBe(false);
    });

    it("accepts a non-terminal status (e.g. processing)", async () => {
      const mod = await import("../lib/tools/update-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "ff_123",
        patch: { status: "processing" },
      });
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("PATCHes platform-api fulfilment orders/:id and returns body text", async () => {
      server.use(
        http.patch(
          "https://platform-api.quiqup.com/api/fulfilment/orders/ff_123",
          () => HttpResponse.json({ id: "ff_123", state: "updated" }),
        ),
      );
      const mod = await import("../lib/tools/update-fulfilment-order");
      const result = await mod.spec.handler(auth, {
        order_id: "ff_123",
        patch: { notes: "leave at reception" },
      });
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("ff_123");
      expect(first.text).toContain("updated");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on 422", async () => {
      server.use(
        http.patch(
          "https://platform-api.quiqup.com/api/fulfilment/orders/ff_123",
          () =>
            HttpResponse.json(
              { errors: ["invalid patch"] },
              { status: 422 },
            ),
        ),
      );
      const mod = await import("../lib/tools/update-fulfilment-order");
      await expect(
        mod.spec.handler(auth, {
          order_id: "ff_123",
          patch: { notes: "x" },
        }),
      ).rejects.toThrow(QuiqupHttpError);
      await expect(
        mod.spec.handler(auth, {
          order_id: "ff_123",
          patch: { notes: "x" },
        }),
      ).rejects.toThrow(/422/);
    });
  });
});
