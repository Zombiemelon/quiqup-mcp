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

describe("create_fulfilment_order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validInput = {
    service_kind: "partner_next_day" as const,
    shipping_address: {
      contact_name: "Test User",
      contact_phone: "+971500000000",
      address1: "1 Marina Walk",
      town: "Dubai Marina",
      country_code: "AE",
    },
    items: [{ sku: "SKU1", quantity: 1 }],
  };

  describe("registration", () => {
    it("exposes a spec with the expected name and input schema", async () => {
      const mod = await import("../lib/tools/create-fulfilment-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("create_fulfilment_order");
      expect(mod.spec.description).toMatch(/fulfilment|order/i);
      const ok = mod.spec.inputSchema.safeParse(validInput);
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects non-object input", async () => {
      const mod = await import("../lib/tools/create-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse("not-an-object");
      expect(r.success).toBe(false);
    });

    it("rejects an empty object — required fields enforced", async () => {
      const mod = await import("../lib/tools/create-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it("rejects unknown service_kind values", async () => {
      const mod = await import("../lib/tools/create-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({
        ...validInput,
        service_kind: "rocket",
      });
      expect(r.success).toBe(false);
    });

    it("rejects an empty items array", async () => {
      const mod = await import("../lib/tools/create-fulfilment-order");
      const r = mod.spec.inputSchema.safeParse({ ...validInput, items: [] });
      expect(r.success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("POSTs to platform-api fulfilment orders and returns the body as text", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/orders",
          () => HttpResponse.json({ id: "ff_123", state: "pending" }),
        ),
      );
      const mod = await import("../lib/tools/create-fulfilment-order");
      const result = await mod.spec.handler(auth, validInput);
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("ff_123");
      expect(first.text).toContain("pending");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on 422", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/orders",
          () =>
            HttpResponse.json(
              { errors: ["items is required"] },
              { status: 422 },
            ),
        ),
      );
      const mod = await import("../lib/tools/create-fulfilment-order");
      await expect(
        mod.spec.handler(auth, validInput),
      ).rejects.toThrow(QuiqupHttpError);
      await expect(
        mod.spec.handler(auth, validInput),
      ).rejects.toThrow(/422/);
    });
  });
});
