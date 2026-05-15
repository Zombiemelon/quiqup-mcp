import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
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

const STAGING_URL =
  "https://api.staging.quiqup.com/courier/orders/set_collection_failed";

const VALID_ARGS = {
  order_ids: [111],
  failure_reason_uid: "future_delivery_request",
  failure_reason: "Future Delivery request",
};

function stubStagingPut(opts: {
  status?: number;
  body?: unknown;
}): {
  putCalls: () => number;
  lastBody: () => unknown;
} {
  let putCalls = 0;
  let lastBody: unknown = undefined;
  server.use(
    http.put(STAGING_URL, async ({ request }) => {
      putCalls += 1;
      lastBody = await request.json();
      const status = opts.status ?? 200;
      return HttpResponse.json(
        opts.body ?? { orders: [{ id: 111, state: "collection_failed" }] },
        { status },
      );
    }),
  );
  return { putCalls: () => putCalls, lastBody: () => lastBody };
}

describe("set_collection_failed_batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and STAGING-ONLY description", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("set_collection_failed_batch");
      expect(mod.spec.description).toMatch(/STAGING-ONLY/);
      expect(mod.spec.description).toMatch(/collection_failed/);
    });

    it("declares guardrails (rate-limit + idempotency + audit)", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      expect(mod.spec.guardrails).toBeDefined();
      expect(mod.spec.guardrails?.rateLimit).toEqual({
        capacity: 5,
        refillPerSec: 5 / 60,
      });
      expect(mod.spec.guardrails?.idempotency?.keyArg).toBe("idempotency_key");
      expect(mod.spec.guardrails?.idempotency?.ttlMs).toBe(15 * 60 * 1000);
      expect(mod.spec.guardrails?.audit).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects empty order_ids", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse({
        ...VALID_ARGS,
        order_ids: [],
      });
      expect(r.success).toBe(false);
    });

    it("rejects more than 10 order_ids", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse({
        ...VALID_ARGS,
        order_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-numeric ids", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse({
        ...VALID_ARGS,
        order_ids: ["123"],
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-positive ids", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      expect(
        mod.spec.inputSchema.safeParse({ ...VALID_ARGS, order_ids: [0] })
          .success,
      ).toBe(false);
      expect(
        mod.spec.inputSchema.safeParse({ ...VALID_ARGS, order_ids: [-5] })
          .success,
      ).toBe(false);
    });

    it("requires failure_reason_uid", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse({
        order_ids: [1],
        failure_reason: "Future Delivery request",
      });
      expect(r.success).toBe(false);
    });

    it("requires failure_reason", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse({
        order_ids: [1],
        failure_reason_uid: "future_delivery_request",
      });
      expect(r.success).toBe(false);
    });

    it("rejects empty-string failure_reason_uid and failure_reason", async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      expect(
        mod.spec.inputSchema.safeParse({
          ...VALID_ARGS,
          failure_reason_uid: "",
        }).success,
      ).toBe(false);
      expect(
        mod.spec.inputSchema.safeParse({ ...VALID_ARGS, failure_reason: "" })
          .success,
      ).toBe(false);
    });

    it('rejects environment="production" at the schema layer', async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse({
        ...VALID_ARGS,
        environment: "production",
      });
      expect(r.success).toBe(false);
    });

    it('defaults environment to "staging" when omitted', async () => {
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const r = mod.spec.inputSchema.safeParse(VALID_ARGS);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.environment).toBe("staging");
    });
  });

  describe("happy path", () => {
    it("PUTs https://api.staging.quiqup.com/courier/orders/set_collection_failed with ids + failure fields", async () => {
      const counter = stubStagingPut({});
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const result = await mod.spec.handler(auth, {
        order_ids: [111, 222],
        failure_reason_uid: "future_delivery_request",
        failure_reason: "Future Delivery request",
        environment: "staging",
      });
      expect(result.isError).toBeFalsy();
      expect(counter.putCalls()).toBe(1);
      expect(counter.lastBody()).toEqual({
        order_ids: [111, 222],
        failure_reason_uid: "future_delivery_request",
        failure_reason: "Future Delivery request",
      });

      const block = result.content[0];
      if (block.type !== "text") throw new Error("expected text block");
      expect(block.text).toMatch(/staging/);
      expect(block.text).toMatch(/2 order/);
      expect(block.text).toMatch(/future_delivery_request/);
    });
  });

  describe("upstream 422 via the registerTool wrapper", () => {
    it("returns isError:true with the upstream body (no exception leaks)", async () => {
      stubStagingPut({
        status: 422,
        body: { error: "order not in collecting state" },
      });
      const mod = await import("../lib/tools/set-collection-failed-batch");
      const result = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        ...VALID_ARGS,
      });
      expect(result.isError).toBe(true);
      const block = result.content[0];
      if (block.type !== "text") throw new Error("expected text block");
      expect(block.text).toContain("422");
      expect(block.text).toContain("order not in collecting state");
    });
  });

  describe("rate limit (5 per minute)", () => {
    it("denies the 6th call within the window with a retry hint", async () => {
      stubStagingPut({});
      const mod = await import("../lib/tools/set-collection-failed-batch");
      for (let i = 0; i < 5; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, {
          ...VALID_ARGS,
        });
        expect(r.isError).toBeFalsy();
      }
      const denied = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        ...VALID_ARGS,
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
      const counter = stubStagingPut({});
      const mod = await import("../lib/tools/set-collection-failed-batch");

      const args = { ...VALID_ARGS, idempotency_key: "logical-cf-1" };
      const first = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      const second = await _invokeWithGuardrailsForTests(mod.spec, auth, args);

      expect(counter.putCalls()).toBe(1);
      expect(first.content).toEqual(second.content);
      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
    });
  });
});
