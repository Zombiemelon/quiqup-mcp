import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import {
  _invokeWithGuardrailsForTests,
  type AuthContext,
} from "@/lib/tools/register";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { ScopeViolationError } from "@/lib/middleware/scope";

// Mock the Clerk-session-JWT mint so unit tests don't need real Clerk creds.
// msw intercepts the upstream HTTP at the fetch boundary.
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

const ORDER_ID = "25286218";

// Helper: register both the GET (used by assertOrderBelongsToUser scope check)
// and the PUT (the actual mutation). Counters let tests assert that
// idempotency is actually short-circuiting the upstream PUT.
function stubScopeAndPut(opts: {
  putStatus?: number;
  putBody?: unknown;
}): { getCalls: () => number; putCalls: () => number } {
  let getCalls = 0;
  let putCalls = 0;
  server.use(
    http.get(`https://api-ae.quiqup.com/orders/${ORDER_ID}`, () => {
      getCalls += 1;
      return HttpResponse.json({
        order: { id: Number(ORDER_ID), state: "pending" },
      });
    }),
    http.put(
      `https://api-ae.quiqup.com/orders/${ORDER_ID}/ready_for_collection`,
      () => {
        putCalls += 1;
        const status = opts.putStatus ?? 200;
        if (status === 204) return new HttpResponse(null, { status: 204 });
        return HttpResponse.json(
          opts.putBody ?? {
            order: { id: Number(ORDER_ID), state: "ready_for_collection" },
          },
          { status },
        );
      },
    ),
  );
  return { getCalls: () => getCalls, putCalls: () => putCalls };
}

describe("mark_ready_for_collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and description (no longer disabled)", async () => {
      const mod = await import("../lib/tools/mark-ready-for-collection");
      expect(mod.spec.name).toBe("mark_ready_for_collection");
      // Description still mentions the operation domain.
      expect(mod.spec.description).toMatch(/ready|dispatch|collection/i);
      // Critically: the M6-pending stub language is GONE. If this fires,
      // either the tool got re-disabled or the description regressed.
      expect(mod.spec.description).not.toMatch(/disabled pending M6/i);
      // The irreversibility warning is now load-bearing UX for the LLM.
      expect(mod.spec.description.toLowerCase()).toContain("irreversible");
    });

    it("declares guardrails (rate-limit + idempotency + audit)", async () => {
      const mod = await import("../lib/tools/mark-ready-for-collection");
      expect(mod.spec.guardrails).toBeDefined();
      expect(mod.spec.guardrails?.rateLimit).toEqual({
        capacity: 5,
        refillPerSec: 5 / 60,
      });
      expect(mod.spec.guardrails?.idempotency?.keyArg).toBe("idempotency_key");
      expect(mod.spec.guardrails?.audit).toBe(true);
    });
  });

  describe("input validation", () => {
    it("requires order_id", async () => {
      const mod = await import("../lib/tools/mark-ready-for-collection");
      const r = mod.spec.inputSchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it("rejects non-string order_id", async () => {
      const mod = await import("../lib/tools/mark-ready-for-collection");
      const r = mod.spec.inputSchema.safeParse({ order_id: 12345 });
      expect(r.success).toBe(false);
    });

    it("accepts idempotency_key as optional", async () => {
      const mod = await import("../lib/tools/mark-ready-for-collection");
      const without = mod.spec.inputSchema.safeParse({ order_id: "1" });
      expect(without.success).toBe(true);
      const withKey = mod.spec.inputSchema.safeParse({
        order_id: "1",
        idempotency_key: "stable-ref-1",
      });
      expect(withKey.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("calls GET scope check then PUT ready_for_collection, returning new state", async () => {
      const counter = stubScopeAndPut({});
      const mod = await import("../lib/tools/mark-ready-for-collection");
      const result = await mod.spec.handler(auth, { order_id: ORDER_ID });

      expect(counter.getCalls()).toBe(1);
      expect(counter.putCalls()).toBe(1);
      expect(result.content).toHaveLength(1);
      const block = result.content[0];
      if (block.type !== "text") throw new Error("expected text block");
      expect(block.text).toContain(ORDER_ID);
      expect(block.text).toContain("ready_for_collection");
    });
  });

  describe("scope violation", () => {
    it("throws ScopeViolationError when the scope GET returns 404", async () => {
      let putCalls = 0;
      server.use(
        http.get(`https://api-ae.quiqup.com/orders/${ORDER_ID}`, () =>
          HttpResponse.json({ error: "not found" }, { status: 404 }),
        ),
        http.put(
          `https://api-ae.quiqup.com/orders/${ORDER_ID}/ready_for_collection`,
          () => {
            putCalls += 1;
            return HttpResponse.json({ order: {} });
          },
        ),
      );
      const mod = await import("../lib/tools/mark-ready-for-collection");
      await expect(
        mod.spec.handler(auth, { order_id: ORDER_ID }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
      // The mutating PUT must NOT fire when the scope guard rejects —
      // that's the whole point of the pre-empt.
      expect(putCalls).toBe(0);
    });
  });

  describe("upstream 422 via the registerTool wrapper", () => {
    it("returns isError:true with the upstream body (no exception leaks)", async () => {
      // Stub scope check OK; PUT returns a 422 validation rejection.
      server.use(
        http.get(`https://api-ae.quiqup.com/orders/${ORDER_ID}`, () =>
          HttpResponse.json({
            order: { id: Number(ORDER_ID), state: "pending" },
          }),
        ),
        http.put(
          `https://api-ae.quiqup.com/orders/${ORDER_ID}/ready_for_collection`,
          () =>
            HttpResponse.json(
              { error: "order already dispatched" },
              { status: 422 },
            ),
        ),
      );

      const mod = await import("../lib/tools/mark-ready-for-collection");
      // Invoke through the wrapper so QuiqupHttpError -> structured MCP
      // error mapping is exercised (matches production code path).
      const result = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_id: ORDER_ID,
      });
      expect(result.isError).toBe(true);
      const block = result.content[0];
      if (block.type !== "text") throw new Error("expected text block");
      expect(block.text).toContain("422");
      expect(block.text).toContain("order already dispatched");
    });
  });

  describe("rate limit (5 per minute)", () => {
    it("denies the 6th call within the window with a retry hint", async () => {
      // Each call goes through scope GET + PUT — stub both.
      stubScopeAndPut({});
      const mod = await import("../lib/tools/mark-ready-for-collection");

      // 5 successful invocations consume the bucket.
      for (let i = 0; i < 5; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, {
          order_id: ORDER_ID,
        });
        expect(r.isError).toBeFalsy();
      }
      // 6th must be rate-limited (capacity 5, sub-1 token refill per second).
      const denied = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_id: ORDER_ID,
      });
      expect(denied.isError).toBe(true);
      const block = denied.content[0];
      if (block.type !== "text") throw new Error("expected text block");
      expect(block.text).toMatch(/rate limited/i);
      expect(block.text).toMatch(/retry in \d+ms/i);
    });
  });

  describe("idempotency", () => {
    it("returns the cached result on a second call with the same key + args", async () => {
      const counter = stubScopeAndPut({});
      const mod = await import("../lib/tools/mark-ready-for-collection");

      const args = { order_id: ORDER_ID, idempotency_key: "logical-dispatch-1" };
      const first = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      const second = await _invokeWithGuardrailsForTests(mod.spec, auth, args);

      // The handler ran exactly once: cache short-circuits the second call
      // before scope GET or PUT fire.
      expect(counter.getCalls()).toBe(1);
      expect(counter.putCalls()).toBe(1);

      // Both responses are byte-identical (same cached object).
      expect(first.content).toEqual(second.content);
      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
    });

    it("does NOT cache when the idempotency key is omitted", async () => {
      const counter = stubScopeAndPut({});
      const mod = await import("../lib/tools/mark-ready-for-collection");

      await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_id: ORDER_ID,
      });
      await _invokeWithGuardrailsForTests(mod.spec, auth, {
        order_id: ORDER_ID,
      });
      // Two full upstream round-trips — no caching without an explicit key.
      expect(counter.putCalls()).toBe(2);
    });
  });
});
