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

describe("update_lastmile_order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and accepts a maximal valid input", async () => {
      const mod = await import("../lib/tools/update-lastmile-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("update_lastmile_order");
      expect(mod.spec.description).toMatch(/update|last-mile|payment/i);
      const ok = mod.spec.inputSchema.safeParse({
        order_id: "555",
        patch: { payment_mode: "pre_paid", payment_amount: 0 },
      });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/update-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        patch: { payment_amount: 100 },
      });
      expect(r.success).toBe(false);
    });

    it("rejects empty patch object", async () => {
      const mod = await import("../lib/tools/update-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "555",
        patch: {},
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-number payment_amount", async () => {
      const mod = await import("../lib/tools/update-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "555",
        patch: { payment_amount: "100" },
      });
      expect(r.success).toBe(false);
    });

    it("accepts patch with only payment_mode", async () => {
      const mod = await import("../lib/tools/update-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "555",
        patch: { payment_mode: "paid_on_delivery" },
      });
      expect(r.success).toBe(true);
    });

    it("accepts patch with only payment_amount", async () => {
      const mod = await import("../lib/tools/update-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "555",
        patch: { payment_amount: 250 },
      });
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("PUTs api-ae /orders/:id and returns body text", async () => {
      server.use(
        http.put("https://api-ae.quiqup.com/orders/555", () =>
          HttpResponse.json({ order: { id: 555, payment_amount: 250 } }),
        ),
      );
      const mod = await import("../lib/tools/update-lastmile-order");
      const result = await mod.spec.handler(auth, {
        order_id: "555",
        patch: { payment_amount: 250 },
      });
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("555");
      expect(first.text).toContain("250");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on 422", async () => {
      server.use(
        http.put("https://api-ae.quiqup.com/orders/555", () =>
          HttpResponse.json(
            { errors: ["order is not pending"] },
            { status: 422 },
          ),
        ),
      );
      const mod = await import("../lib/tools/update-lastmile-order");
      await expect(
        mod.spec.handler(auth, {
          order_id: "555",
          patch: { payment_amount: 250 },
        }),
      ).rejects.toThrow(QuiqupHttpError);
      await expect(
        mod.spec.handler(auth, {
          order_id: "555",
          patch: { payment_amount: 250 },
        }),
      ).rejects.toThrow(/422/);
    });
  });
});
