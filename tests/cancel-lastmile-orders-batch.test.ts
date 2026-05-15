import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { _invokeWithGuardrailsForTests } from "@/lib/tools/register";

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

/**
 * Wire MSW handlers that make every order id in `ownedIds` appear scope-clean
 * (GET /orders/:id → 200) and every id in `deniedIds` look foreign (404).
 * Also installs the batch-cancel PUT handler, gated by a counter so tests can
 * assert it was (or wasn't) hit.
 */
function wireMsw(opts: {
  ownedIds: string[];
  deniedIds?: string[];
  batchCancelResponse?: () => Response;
}): { batchPutCalls: () => number } {
  let batchCalls = 0;
  for (const id of opts.ownedIds) {
    server.use(
      http.get(`https://api-ae.quiqup.com/orders/${id}`, () =>
        HttpResponse.json({ order: { id, state: "pending" } }),
      ),
    );
  }
  for (const id of opts.deniedIds ?? []) {
    server.use(
      http.get(`https://api-ae.quiqup.com/orders/${id}`, () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
  }
  server.use(
    http.put(
      "https://api-ae.quiqup.com/orders/batch/set_cancelled",
      () => {
        batchCalls += 1;
        return (
          opts.batchCancelResponse?.() ??
          HttpResponse.json({
            orders: opts.ownedIds.map((id) => ({ id, state: "cancelled" })),
          })
        );
      },
    ),
  );
  return { batchPutCalls: () => batchCalls };
}

describe("cancel_lastmile_orders_batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and no 'disabled' language", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("cancel_lastmile_orders_batch");
      expect(mod.spec.description).toMatch(/cancel/i);
      expect(mod.spec.description).not.toMatch(/disabled pending M6/i);
      expect(mod.spec.description).not.toMatch(/currently disabled/i);
      expect(mod.spec.guardrails).toBeDefined();
    });
  });

  describe("input validation", () => {
    it("rejects missing order_ids", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it("rejects empty order_ids array", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({ order_ids: [] });
      expect(r.success).toBe(false);
    });

    it("rejects non-array order_ids", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({ order_ids: "123" });
      expect(r.success).toBe(false);
    });

    it("rejects more than 10 order_ids", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({
        order_ids: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
      });
      expect(r.success).toBe(false);
    });

    it("rejects empty-string entries", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({ order_ids: [""] });
      expect(r.success).toBe(false);
    });

    it("accepts an optional idempotency_key", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({
        order_ids: ["1"],
        idempotency_key: "abc-123",
      });
      expect(r.success).toBe(true);
    });

    it("accepts the maximal valid batch of 10", async () => {
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const r = mod.spec.inputSchema.safeParse({
        order_ids: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      });
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("scope-checks each id then PUTs /orders/batch/set_cancelled and summarises", async () => {
      const { batchPutCalls } = wireMsw({ ownedIds: ["111", "222", "333"] });
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const result = await mod.spec.handler(auth, {
        order_ids: ["111", "222", "333"],
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("Cancelled 3 order(s)");
      expect(first.text).toContain("cancelled");
      expect(batchPutCalls()).toBe(1);
    });
  });

  describe("partial scope violation", () => {
    it("refuses the entire batch, names the denied id, and does NOT call the upstream PUT", async () => {
      const { batchPutCalls } = wireMsw({
        ownedIds: ["111", "333"],
        deniedIds: ["222"],
      });
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      const result = await mod.spec.handler(auth, {
        order_ids: ["111", "222", "333"],
      });
      expect(result.isError).toBe(true);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/refused/i);
      expect(first.text).toContain("222");
      expect(first.text).not.toMatch(/Cancelled \d+ order/);
      expect(batchPutCalls()).toBe(0);
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on upstream 422", async () => {
      wireMsw({
        ownedIds: ["111"],
        batchCancelResponse: () =>
          HttpResponse.json(
            { errors: ["order not in pending state"] },
            { status: 422 },
          ),
      });
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");
      await expect(
        mod.spec.handler(auth, { order_ids: ["111"] }),
      ).rejects.toThrow(QuiqupHttpError);
    });
  });

  describe("idempotency", () => {
    it("returns the cached result on a second call with the same key + ids", async () => {
      const { batchPutCalls } = wireMsw({ ownedIds: ["111"] });
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");

      const r1 = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_ids: ["111"],
        idempotency_key: "key-xyz",
      });
      const r2 = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_ids: ["111"],
        idempotency_key: "key-xyz",
      });

      // Only one upstream PUT (the second call was served from cache; the
      // scope GET also wouldn't fire because the whole handler is wrapped).
      expect(batchPutCalls()).toBe(1);
      // Same cached payload returned both times.
      if (r1.content[0].type !== "text" || r2.content[0].type !== "text") {
        throw new Error("expected text blocks");
      }
      expect(r1.content[0].text).toBe(r2.content[0].text);
    });
  });

  describe("rate limit", () => {
    it("denies the 4th call within the minute (capacity=3, refill=3/60s)", async () => {
      wireMsw({ ownedIds: ["111"] });
      const mod = await import("../lib/tools/cancel-lastmile-orders-batch");

      for (let i = 0; i < 3; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, {
          order_ids: ["111"],
        });
        expect(r.isError).toBeFalsy();
      }
      const denied = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_ids: ["111"],
      });
      expect(denied.isError).toBe(true);
      const first = denied.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/Rate limited; retry in \d+ms/);
    });
  });
});
