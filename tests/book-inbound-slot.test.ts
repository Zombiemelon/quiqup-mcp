import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { _invokeWithGuardrailsForTests } from "@/lib/tools/register";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { ScopeViolationError } from "@/lib/middleware/scope";
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
  scopes: ["write"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

const FULFILMENT = "https://platform-api.quiqup.com";

describe("book_inbound_slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
  });

  describe("registration", () => {
    it("registers under the expected name with M6 guardrails wired", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      expect(mod.spec.name).toBe("book_inbound_slot");
      expect(mod.spec.description).toMatch(/inbound|slot|warehouse/i);
      // Sanity: no longer carries the "DISABLED pending M6" warning string.
      expect(mod.spec.description).not.toMatch(/disabled pending M6/i);
      expect(mod.spec.description).not.toMatch(/currently disabled/i);
      // Guardrails attached per task spec.
      expect(mod.spec.guardrails).toBeDefined();
      expect(mod.spec.guardrails?.rateLimit?.capacity).toBe(3);
      expect(mod.spec.guardrails?.idempotency?.keyArg).toBe("idempotency_key");
      expect(mod.spec.guardrails?.audit).toBe(true);
    });
  });

  describe("input validation", () => {
    it("accepts inbound_id + slot_id (idempotency_key optional)", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      const ok = mod.spec.inputSchema.safeParse({
        inbound_id: "ib_1",
        slot_id: "slot_1",
      });
      expect(ok.success).toBe(true);
    });

    it("accepts idempotency_key when provided", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      const ok = mod.spec.inputSchema.safeParse({
        inbound_id: "ib_1",
        slot_id: "slot_1",
        idempotency_key: "uuid-abc",
      });
      expect(ok.success).toBe(true);
    });

    it("rejects missing slot_id", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      expect(
        mod.spec.inputSchema.safeParse({ inbound_id: "ib_1" }).success,
      ).toBe(false);
    });

    it("rejects missing inbound_id", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      expect(
        mod.spec.inputSchema.safeParse({ slot_id: "slot_1" }).success,
      ).toBe(false);
    });

    it("rejects empty-string slot_id", async () => {
      const mod = await import("../lib/tools/book-inbound-slot");
      expect(
        mod.spec.inputSchema.safeParse({
          inbound_id: "ib_1",
          slot_id: "",
        }).success,
      ).toBe(false);
    });
  });

  describe("happy path", () => {
    it("verifies ownership then books the slot and returns success text", async () => {
      let getCalls = 0;
      let postCalls = 0;
      server.use(
        http.get(`${FULFILMENT}/api/fulfilment/inbounds/ib_1`, () => {
          getCalls += 1;
          return HttpResponse.json({ id: "ib_1", state: "pending" });
        }),
        http.post(
          `${FULFILMENT}/api/fulfilment/inbounds/ib_1/book_slot`,
          async ({ request }) => {
            postCalls += 1;
            const body = (await request.json()) as { slot_id: string };
            return HttpResponse.json({
              slot_id: body.slot_id,
              capacity_remaining: 7,
            });
          },
        ),
      );
      const mod = await import("../lib/tools/book-inbound-slot");
      const r = await mod.spec.handler(auth, {
        inbound_id: "ib_1",
        slot_id: "slot_xyz",
      });
      expect(getCalls).toBe(1);
      expect(postCalls).toBe(1);
      const first = r.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("slot_xyz");
      expect(first.text).toContain("ib_1");
      expect(first.text).toContain("7"); // capacity remaining
    });
  });

  describe("scope violation", () => {
    it("throws ScopeViolationError when the ownership GET returns 404", async () => {
      let postCalls = 0;
      server.use(
        http.get(`${FULFILMENT}/api/fulfilment/inbounds/ib_foreign`, () =>
          HttpResponse.json({ error: "not_found" }, { status: 404 }),
        ),
        http.post(
          `${FULFILMENT}/api/fulfilment/inbounds/ib_foreign/book_slot`,
          () => {
            postCalls += 1;
            return HttpResponse.json({ slot_id: "should-not-happen" });
          },
        ),
      );
      const mod = await import("../lib/tools/book-inbound-slot");
      await expect(
        mod.spec.handler(auth, {
          inbound_id: "ib_foreign",
          slot_id: "slot_xyz",
        }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
      // Critically: the POST must not have fired.
      expect(postCalls).toBe(0);
    });
  });

  describe("upstream conflict", () => {
    it("bubbles QuiqupHttpError on 409 slot conflict (no double-wrap)", async () => {
      server.use(
        http.get(`${FULFILMENT}/api/fulfilment/inbounds/ib_1`, () =>
          HttpResponse.json({ id: "ib_1" }),
        ),
        http.post(
          `${FULFILMENT}/api/fulfilment/inbounds/ib_1/book_slot`,
          () =>
            HttpResponse.json(
              { error: "slot_full" },
              { status: 409 },
            ),
        ),
      );
      const mod = await import("../lib/tools/book-inbound-slot");
      await expect(
        mod.spec.handler(auth, {
          inbound_id: "ib_1",
          slot_id: "slot_taken",
        }),
      ).rejects.toBeInstanceOf(QuiqupHttpError);
    });

    it("bubbles QuiqupHttpError on 422 validation rejection", async () => {
      server.use(
        http.get(`${FULFILMENT}/api/fulfilment/inbounds/ib_1`, () =>
          HttpResponse.json({ id: "ib_1" }),
        ),
        http.post(
          `${FULFILMENT}/api/fulfilment/inbounds/ib_1/book_slot`,
          () =>
            HttpResponse.json(
              { error_details: [{ detail: "slot_id invalid" }] },
              { status: 422 },
            ),
        ),
      );
      const mod = await import("../lib/tools/book-inbound-slot");
      await expect(
        mod.spec.handler(auth, {
          inbound_id: "ib_1",
          slot_id: "slot_bad",
        }),
      ).rejects.toBeInstanceOf(QuiqupHttpError);
    });
  });

  describe("idempotency (via registerTool wrapper)", () => {
    it("caches the second call with the same key + slot (POST fires once)", async () => {
      let postCalls = 0;
      server.use(
        http.get(`${FULFILMENT}/api/fulfilment/inbounds/ib_1`, () =>
          HttpResponse.json({ id: "ib_1" }),
        ),
        http.post(
          `${FULFILMENT}/api/fulfilment/inbounds/ib_1/book_slot`,
          async ({ request }) => {
            postCalls += 1;
            const body = (await request.json()) as { slot_id: string };
            return HttpResponse.json({
              slot_id: body.slot_id,
              capacity_remaining: 5,
            });
          },
        ),
      );
      const mod = await import("../lib/tools/book-inbound-slot");

      const args = {
        inbound_id: "ib_1",
        slot_id: "slot_xyz",
        idempotency_key: "key-stable-1",
      };
      const r1 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      const r2 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      // The second call short-circuits in idempotency cache; POST fires once.
      expect(postCalls).toBe(1);
      // And both calls return identical content (the cached value).
      expect(r2.content).toEqual(r1.content);
    });
  });

  describe("rate limit (via registerTool wrapper)", () => {
    it("denies the 4th call when capacity=3 (3 bookings/min budget)", async () => {
      server.use(
        http.get(/\/api\/fulfilment\/inbounds\/ib_/, () =>
          HttpResponse.json({ id: "ib_x" }),
        ),
        http.post(/\/api\/fulfilment\/inbounds\/ib_.+\/book_slot/, () =>
          HttpResponse.json({ slot_id: "slot_x", capacity_remaining: 1 }),
        ),
      );
      const mod = await import("../lib/tools/book-inbound-slot");

      // Three successful calls (unique idempotency keys so we don't hit the
      // idempotency cache and bypass rate-limit accounting via a cache hit).
      for (let i = 0; i < 3; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, {
          inbound_id: `ib_${i}`,
          slot_id: `slot_${i}`,
          idempotency_key: `k-${i}`,
        });
        expect(r.isError).toBeFalsy();
      }
      // Fourth call: bucket empty, denied with rate-limit error result.
      const denied = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        inbound_id: "ib_3",
        slot_id: "slot_3",
        idempotency_key: "k-3",
      });
      expect(denied.isError).toBe(true);
      const first = denied.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/rate limited/i);
    });
  });
});
