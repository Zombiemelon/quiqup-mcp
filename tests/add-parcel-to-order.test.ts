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

describe("add_parcel_to_order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and accepts a maximal valid input", async () => {
      const mod = await import("../lib/tools/add-parcel-to-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("add_parcel_to_order");
      expect(mod.spec.description).toMatch(/parcel|add|order/i);
      const ok = mod.spec.inputSchema.safeParse({
        order_id: "555",
        parcel: {
          description: "Extra box",
          weight: 2.5,
          dimensions: { length: 10, width: 10, height: 10 },
          barcode: "PKG-1",
        },
      });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/add-parcel-to-order");
      const r = mod.spec.inputSchema.safeParse({ parcel: {} });
      expect(r.success).toBe(false);
    });

    it("rejects missing parcel", async () => {
      const mod = await import("../lib/tools/add-parcel-to-order");
      const r = mod.spec.inputSchema.safeParse({ order_id: "555" });
      expect(r.success).toBe(false);
    });

    it("rejects non-object parcel", async () => {
      const mod = await import("../lib/tools/add-parcel-to-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "555",
        parcel: "not-an-object",
      });
      expect(r.success).toBe(false);
    });

    it("accepts an empty parcel object (passthrough)", async () => {
      const mod = await import("../lib/tools/add-parcel-to-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "555",
        parcel: {},
      });
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("POSTs api-ae /orders/:id/parcels and returns body text", async () => {
      server.use(
        http.post("https://api-ae.quiqup.com/orders/555/parcels", () =>
          HttpResponse.json({ parcel: { id: "pcl_1", barcode: "PKG-1" } }),
        ),
      );
      const mod = await import("../lib/tools/add-parcel-to-order");
      const result = await mod.spec.handler(auth, {
        order_id: "555",
        parcel: { barcode: "PKG-1" },
      });
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("pcl_1");
      expect(first.text).toContain("PKG-1");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on 422", async () => {
      server.use(
        http.post("https://api-ae.quiqup.com/orders/555/parcels", () =>
          HttpResponse.json(
            { errors: ["order is not pending"] },
            { status: 422 },
          ),
        ),
      );
      const mod = await import("../lib/tools/add-parcel-to-order");
      await expect(
        mod.spec.handler(auth, {
          order_id: "555",
          parcel: { barcode: "PKG-1" },
        }),
      ).rejects.toThrow(QuiqupHttpError);
      await expect(
        mod.spec.handler(auth, {
          order_id: "555",
          parcel: { barcode: "PKG-1" },
        }),
      ).rejects.toThrow(/422/);
    });
  });
});
