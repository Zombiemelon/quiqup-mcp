import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { ScopeViolationError } from "@/lib/middleware/scope";
import {
  _invokeWithGuardrailsForTests,
  type AuthContext,
} from "@/lib/tools/register";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "test-jwt-for-msw"),
  };
});

const auth: AuthContext = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["read"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

// Stub a passing ownership check by default; individual tests can override
// to simulate scope violations.
function stubOwnership(orderId: string, ok: boolean = true) {
  server.use(
    http.get(`https://api-ae.quiqup.com/orders/${orderId}`, () =>
      ok
        ? HttpResponse.json({ order: { id: Number(orderId) || orderId, state: "pending" } })
        : HttpResponse.json({ error: "not found" }, { status: 404 }),
    ),
  );
}

describe("remove_parcel_from_order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
    // Silence audit lines emitted by the guardrail wrapper during tests.
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and no 'disabled pending M6' wording", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("remove_parcel_from_order");
      expect(mod.spec.description).toMatch(/parcel|remove|delete/i);
      expect(mod.spec.description).not.toMatch(/disabled/i);
      expect(mod.spec.description).not.toMatch(/M6/);
      expect(mod.spec.description).not.toMatch(/pending/i);
      // The "cannot remove the last parcel" caveat must stay in the description.
      expect(mod.spec.description).toMatch(/last parcel/i);
    });

    it("declares the M6 guardrail config (rate-limit + idempotency + audit)", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      expect(mod.spec.guardrails).toBeDefined();
      expect(mod.spec.guardrails?.rateLimit).toEqual({
        capacity: 10,
        refillPerSec: 10 / 60,
      });
      expect(mod.spec.guardrails?.idempotency?.keyArg).toBe("idempotency_key");
      expect(mod.spec.guardrails?.idempotency?.ttlMs).toBe(15 * 60 * 1000);
      expect(mod.spec.guardrails?.audit).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({ parcel_id: "parcel_1" });
      expect(r.success).toBe(false);
    });

    it("rejects missing parcel_id", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({ order_id: "order_1" });
      expect(r.success).toBe(false);
    });

    it("rejects non-string parcel_id", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "order_1",
        parcel_id: 99,
      });
      expect(r.success).toBe(false);
    });

    it("accepts an optional idempotency_key", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "order_1",
        parcel_id: "parcel_1",
        idempotency_key: "abc-123",
      });
      expect(r.success).toBe(true);
    });

    it("accepts input without an idempotency_key (key is optional)", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const r = mod.spec.inputSchema.safeParse({
        order_id: "order_1",
        parcel_id: "parcel_1",
      });
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("scope-GETs the order then DELETEs the parcel and returns a confirmation with the remaining-parcel count", async () => {
      stubOwnership("555");
      server.use(
        http.delete(
          "https://api-ae.quiqup.com/orders/555/parcels/pcl_42",
          () =>
            HttpResponse.json({
              order: {
                id: 555,
                items: [
                  { id: "pcl_1", parcel_barcode: "BC-1" },
                  { id: "pcl_2", parcel_barcode: "BC-2" },
                ],
              },
            }),
        ),
      );
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const result = await mod.spec.handler(auth, {
        order_id: "555",
        parcel_id: "pcl_42",
      });
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("Removed parcel pcl_42");
      expect(first.text).toContain("order 555");
      expect(first.text).toContain("2 parcel(s) remaining");
    });

    it("handles 204 No Content from upstream", async () => {
      stubOwnership("777");
      server.use(
        http.delete(
          "https://api-ae.quiqup.com/orders/777/parcels/pcl_x",
          () => new HttpResponse(null, { status: 204 }),
        ),
      );
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const result = await mod.spec.handler(auth, {
        order_id: "777",
        parcel_id: "pcl_x",
      });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("Removed parcel pcl_x");
      expect(first.text).toContain("order 777");
    });
  });

  describe("scope check", () => {
    it("throws ScopeViolationError when ownership GET returns 404 (foreign order)", async () => {
      stubOwnership("999", false);
      // Crucially: the DELETE must NOT be reachable. msw's onUnhandledRequest:'error'
      // would surface any DELETE that slipped past the scope check.
      const mod = await import("../lib/tools/remove-parcel-from-order");
      await expect(
        mod.spec.handler(auth, {
          order_id: "999",
          parcel_id: "pcl_42",
        }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it("rejects when auth.userId is null (unauthenticated)", async () => {
      const mod = await import("../lib/tools/remove-parcel-from-order");
      await expect(
        mod.spec.handler(
          { ...auth, userId: null },
          { order_id: "555", parcel_id: "pcl_42" },
        ),
      ).rejects.toThrow(/authenticated user/);
    });
  });

  describe("upstream rejection (last-parcel guard, 422)", () => {
    it("propagates QuiqupHttpError from upstream and the registerTool wrapper maps it to an isError result", async () => {
      stubOwnership("555");
      server.use(
        http.delete(
          "https://api-ae.quiqup.com/orders/555/parcels/pcl_last",
          () =>
            HttpResponse.json(
              {
                error: "cannot remove the last parcel of an order",
              },
              { status: 422 },
            ),
        ),
      );
      const mod = await import("../lib/tools/remove-parcel-from-order");
      // Direct handler call: raw QuiqupHttpError surface.
      await expect(
        mod.spec.handler(auth, {
          order_id: "555",
          parcel_id: "pcl_last",
        }),
      ).rejects.toThrow(QuiqupHttpError);

      // Going through the guardrail wrapper: QuiqupHttpError is mapped to an
      // isError tool result (text + isError:true).
      const wrapped = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_id: "555",
        parcel_id: "pcl_last",
      });
      expect(wrapped.isError).toBe(true);
      const first = wrapped.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/422/);
      expect(first.text).toMatch(/last parcel/i);
    });
  });

  describe("idempotency", () => {
    it("re-using the same idempotency_key + args returns the cached result without a second upstream DELETE", async () => {
      stubOwnership("555");
      let deleteCalls = 0;
      server.use(
        http.delete(
          "https://api-ae.quiqup.com/orders/555/parcels/pcl_42",
          () => {
            deleteCalls += 1;
            return HttpResponse.json({
              order: { id: 555, items: [{ id: "pcl_1" }] },
            });
          },
        ),
      );
      const mod = await import("../lib/tools/remove-parcel-from-order");
      const args = {
        order_id: "555",
        parcel_id: "pcl_42",
        idempotency_key: "key-abc",
      };
      const r1 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      const r2 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      expect(deleteCalls).toBe(1);
      // Cached body identical.
      const t1 = r1.content[0];
      const t2 = r2.content[0];
      if (t1.type !== "text" || t2.type !== "text")
        throw new Error("expected text blocks");
      expect(t1.text).toBe(t2.text);
    });
  });

  describe("rate-limit smoke", () => {
    it("denies the 11th call within the burst window (capacity=10)", async () => {
      stubOwnership("555");
      server.use(
        http.delete(
          "https://api-ae.quiqup.com/orders/555/parcels/:pid",
          () =>
            HttpResponse.json({
              order: { id: 555, items: [{ id: "pcl_1" }] },
            }),
        ),
      );
      const mod = await import("../lib/tools/remove-parcel-from-order");
      for (let i = 0; i < 10; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, {
          order_id: "555",
          parcel_id: `pcl_${i}`,
        });
        expect(r.isError).toBeFalsy();
      }
      const denied = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_id: "555",
        parcel_id: "pcl_overflow",
      });
      expect(denied.isError).toBe(true);
      const first = denied.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/Rate limited/i);
    });
  });
});
