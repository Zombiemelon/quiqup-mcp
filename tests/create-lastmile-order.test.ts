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

const maximalValid = {
  kind: "partner_same_day" as const,
  payment_mode: "paid_on_delivery" as const,
  payment_amount: 150,
  origin: {
    contact_name: "Sender Inc",
    contact_phone: "+971500000000",
    contact_email: "send@example.com",
    address: {
      address1: "1 Origin St",
      address2: "Suite 1",
      town: "Dubai",
      city: "Dubai",
      country: "AE",
      coordinates: { lat: 25.2048, lng: 55.2708 },
    },
    notes: "ring bell",
  },
  destination: {
    contact_name: "Recipient",
    contact_phone: "+971500000001",
    address: {
      address1: "1 Dest St",
      town: "Sharjah",
      country: "AE",
    },
  },
  items: [
    { name: "Box", quantity: 1, weight: 5, dimensions: { length: 10, width: 10, height: 10 } },
  ],
  partner_order_id: "MCP_TEST_1",
  service_kind: "partner_same_day",
  notes: "handle with care",
};

describe("create_lastmile_order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and accepts a maximal valid input", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("create_lastmile_order");
      expect(mod.spec.description).toMatch(/last-mile|order|create/i);
      const r = mod.spec.inputSchema.safeParse(maximalValid);
      expect(r.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing origin", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const { origin: _o, ...rest } = maximalValid;
      const r = mod.spec.inputSchema.safeParse(rest);
      expect(r.success).toBe(false);
    });

    it("rejects missing destination", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const { destination: _d, ...rest } = maximalValid;
      const r = mod.spec.inputSchema.safeParse(rest);
      expect(r.success).toBe(false);
    });

    it("rejects empty items array", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({ ...maximalValid, items: [] });
      expect(r.success).toBe(false);
    });

    it("rejects unknown kind", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        ...maximalValid,
        kind: "supersonic_delivery",
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-number payment_amount", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        ...maximalValid,
        payment_amount: "150",
      });
      expect(r.success).toBe(false);
    });

    it("accepts pre_paid with payment_amount = 0", async () => {
      // Schema does not enforce the cross-field rule; description documents it.
      const mod = await import("../lib/tools/create-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        ...maximalValid,
        payment_mode: "pre_paid",
        payment_amount: 0,
      });
      expect(r.success).toBe(true);
    });

    it("accepts paid_on_delivery with payment_amount > 0", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        ...maximalValid,
        payment_mode: "paid_on_delivery",
        payment_amount: 150,
      });
      expect(r.success).toBe(true);
    });

    it("rejects address missing required address1", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const broken = {
        ...maximalValid,
        origin: {
          ...maximalValid.origin,
          address: {
            town: "Dubai",
            country: "AE",
          },
        },
      };
      const r = mod.spec.inputSchema.safeParse(broken);
      expect(r.success).toBe(false);
    });

    it("rejects item with quantity < 1", async () => {
      const mod = await import("../lib/tools/create-lastmile-order");
      const r = mod.spec.inputSchema.safeParse({
        ...maximalValid,
        items: [{ name: "Box", quantity: 0 }],
      });
      expect(r.success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("POSTs to api-ae /orders and returns body text", async () => {
      server.use(
        http.post("https://api-ae.quiqup.com/orders", () =>
          HttpResponse.json({ order: { id: 555, state: "pending" } }),
        ),
      );
      const mod = await import("../lib/tools/create-lastmile-order");
      const result = await mod.spec.handler(auth, maximalValid);
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("555");
      expect(first.text).toContain("pending");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on 422", async () => {
      server.use(
        http.post("https://api-ae.quiqup.com/orders", () =>
          HttpResponse.json(
            { errors: ["origin is missing"] },
            { status: 422 },
          ),
        ),
      );
      const mod = await import("../lib/tools/create-lastmile-order");
      await expect(
        mod.spec.handler(auth, maximalValid),
      ).rejects.toThrow(QuiqupHttpError);
      await expect(
        mod.spec.handler(auth, maximalValid),
      ).rejects.toThrow(/422/);
    });
  });
});
