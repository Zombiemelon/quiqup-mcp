import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import {
  _invokeWithGuardrailsForTests,
  type AuthContext,
} from "@/lib/tools/register";
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

const auth: AuthContext = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["write"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

const SKU_OK_URL = "https://platform-api.quiqup.com/api/fulfilment/products/:sku";
const ADJ_URL =
  "https://platform-api.quiqup.com/api/fulfilment/inventory/adjustments";

/** Stub the scope GET to a 200 (sku owned by this caller). */
function stubScopeOk(sku: string) {
  server.use(
    http.get(SKU_OK_URL, ({ params }) => {
      if (params.sku === sku) return HttpResponse.json({ sku, ok: true });
      return HttpResponse.json({ error: "not found" }, { status: 404 });
    }),
  );
}

/** Stub the scope GET to a 404 (sku not owned / not exists). */
function stubScopeNotFound() {
  server.use(
    http.get(SKU_OK_URL, () =>
      HttpResponse.json({ error: "not found" }, { status: 404 }),
    ),
  );
}

describe("adjust_stock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
    // Silence audit lines emitted by the guardrail wrapper so test output
    // stays clean. We're not asserting audit contents here — that's
    // exercised in tests/register-tool.test.ts.
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and required input schema, without 'disabled pending M6'", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("adjust_stock");
      expect(mod.spec.description).toMatch(/stock|inventory|adjust/i);
      expect(mod.spec.description).not.toMatch(/disabled pending m6/i);
      expect(mod.spec.description).not.toMatch(/CURRENTLY DISABLED/);
      // The "always sensitive" intent should survive.
      expect(mod.spec.description).toMatch(/sensitive/i);

      const ok = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: -1,
        reason: "audit correction",
      });
      expect(ok.success).toBe(true);
    });

    it("declares guardrails: rate-limit 5/min, idempotency on idempotency_key, audit on", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      expect(mod.spec.guardrails).toBeDefined();
      const g = mod.spec.guardrails!;
      expect(g.rateLimit?.capacity).toBe(5);
      // 5 per 60s -> 5/60 refillPerSec
      expect(g.rateLimit?.refillPerSec).toBeCloseTo(5 / 60, 6);
      expect(g.idempotency?.keyArg).toBe("idempotency_key");
      expect(g.idempotency?.ttlMs).toBe(15 * 60 * 1000);
      expect(g.audit).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing sku", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        bucket: "sellable",
        delta: 1,
        reason: "x",
      });
      expect(r.success).toBe(false);
    });

    it("rejects missing delta", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        reason: "x",
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-integer delta (decimal)", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: 1.5,
        reason: "x",
      });
      expect(r.success).toBe(false);
    });

    it("rejects non-numeric delta", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: "1",
        reason: "x",
      });
      expect(r.success).toBe(false);
    });

    it("accepts idempotency_key + confirm_zero as optional", async () => {
      const mod = await import("../lib/tools/adjust-stock");
      const r = mod.spec.inputSchema.safeParse({
        sku: "SKU-1",
        bucket: "sellable",
        delta: 0,
        reason: "noop probe",
        idempotency_key: "abc-123",
        confirm_zero: true,
      });
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("positive delta: scope ok, POST 200 -> success summary", async () => {
      stubScopeOk("SKU-1");
      let receivedBody: unknown = null;
      server.use(
        http.post(ADJ_URL, async ({ request }) => {
          receivedBody = await request.json();
          return HttpResponse.json({
            sku: "SKU-1",
            bucket: "sellable",
            before: 10,
            after: 13,
            delta: 3,
          });
        }),
      );

      const mod = await import("../lib/tools/adjust-stock");
      const result = await mod.spec.handler(auth, {
        sku: "SKU-1",
        bucket: "sellable",
        delta: 3,
        reason: "restock",
      });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("SKU-1");
      expect(first.text).toContain("sellable");
      expect(first.text).toContain("delta=3");
      expect(first.text).toContain("before=10");
      expect(first.text).toContain("after=13");
      expect(result.isError).toBeFalsy();

      // Internal flags must not leak upstream.
      expect(receivedBody).toMatchObject({
        sku: "SKU-1",
        bucket: "sellable",
        delta: 3,
        reason: "restock",
      });
      const body = receivedBody as Record<string, unknown>;
      expect(body).not.toHaveProperty("idempotency_key");
      expect(body).not.toHaveProperty("confirm_zero");
    });

    it("negative delta: scope ok, POST 200 -> success summary", async () => {
      stubScopeOk("SKU-2");
      server.use(
        http.post(ADJ_URL, () =>
          HttpResponse.json({
            sku: "SKU-2",
            bucket: "damaged",
            before: 5,
            after: 3,
            delta: -2,
          }),
        ),
      );

      const mod = await import("../lib/tools/adjust-stock");
      const result = await mod.spec.handler(auth, {
        sku: "SKU-2",
        bucket: "damaged",
        delta: -2,
        reason: "damage write-off",
      });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("SKU-2");
      expect(first.text).toContain("delta=-2");
      expect(result.isError).toBeFalsy();
    });
  });

  describe("zero-delta confirm gate", () => {
    it("delta=0 without confirm_zero -> structured isError, NO upstream call", async () => {
      // Deliberately do NOT register a scope or POST handler — if the
      // handler reaches the fetch boundary, msw's onUnhandledRequest: "error"
      // will fail the test.
      const mod = await import("../lib/tools/adjust-stock");
      const result = await mod.spec.handler(auth, {
        sku: "SKU-Z",
        bucket: "sellable",
        delta: 0,
        reason: "probe",
      });
      expect(result.isError).toBe(true);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/confirm_zero/);
      expect(first.text).toMatch(/no-op|mistake|did you forget/i);
    });

    it("delta=0 with confirm_zero -> scope ok, POST 200 -> success", async () => {
      stubScopeOk("SKU-Z");
      server.use(
        http.post(ADJ_URL, () =>
          HttpResponse.json({
            sku: "SKU-Z",
            bucket: "sellable",
            before: 7,
            after: 7,
            delta: 0,
          }),
        ),
      );
      const mod = await import("../lib/tools/adjust-stock");
      const result = await mod.spec.handler(auth, {
        sku: "SKU-Z",
        bucket: "sellable",
        delta: 0,
        reason: "intentional re-assert",
        confirm_zero: true,
      });
      expect(result.isError).toBeFalsy();
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("delta=0");
    });
  });

  describe("scope enforcement", () => {
    it("throws ScopeViolationError when sku 404s under user's session, no POST issued", async () => {
      stubScopeNotFound();
      // No POST handler — onUnhandledRequest: "error" guarantees the adjust
      // POST is never attempted.
      const mod = await import("../lib/tools/adjust-stock");
      await expect(
        mod.spec.handler(auth, {
          sku: "SKU-FOREIGN",
          bucket: "sellable",
          delta: 1,
          reason: "x",
        }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });
  });

  describe("upstream errors", () => {
    it("bubbles a QuiqupHttpError on upstream 422", async () => {
      stubScopeOk("SKU-3");
      server.use(
        http.post(ADJ_URL, () =>
          HttpResponse.json(
            { error: "delta would drive bucket negative" },
            { status: 422 },
          ),
        ),
      );
      const mod = await import("../lib/tools/adjust-stock");
      await expect(
        mod.spec.handler(auth, {
          sku: "SKU-3",
          bucket: "sellable",
          delta: -9999,
          reason: "huge negative",
        }),
      ).rejects.toBeInstanceOf(QuiqupHttpError);
    });
  });

  describe("guardrails integration", () => {
    it("idempotency: same key + same args returns cached result (single upstream POST)", async () => {
      stubScopeOk("SKU-IDM");
      let postCount = 0;
      server.use(
        http.post(ADJ_URL, () => {
          postCount += 1;
          return HttpResponse.json({
            sku: "SKU-IDM",
            bucket: "sellable",
            before: 10,
            after: 11,
            delta: 1,
          });
        }),
      );

      const mod = await import("../lib/tools/adjust-stock");
      const args = {
        sku: "SKU-IDM",
        bucket: "sellable",
        delta: 1,
        reason: "restock",
        idempotency_key: "stable-key-abc",
      };
      const r1 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      const r2 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      expect(postCount).toBe(1);
      if (r1.content[0].type !== "text" || r2.content[0].type !== "text")
        throw new Error("expected text block");
      expect(r2.content[0].text).toBe(r1.content[0].text);
    });

    it("rate-limit: 6th call within bucket window is denied", async () => {
      stubScopeOk("SKU-RL");
      server.use(
        http.post(ADJ_URL, () =>
          HttpResponse.json({
            sku: "SKU-RL",
            bucket: "sellable",
            before: 0,
            after: 1,
            delta: 1,
          }),
        ),
      );

      const mod = await import("../lib/tools/adjust-stock");
      // Distinct idempotency keys per call so the cache doesn't dedupe them.
      for (let i = 0; i < 5; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, {
          sku: "SKU-RL",
          bucket: "sellable",
          delta: 1,
          reason: "drip restock",
          idempotency_key: `k-${i}`,
        });
        expect(r.isError).toBeFalsy();
      }
      const denied = await _invokeWithGuardrailsForTests(mod.spec, auth, {
        sku: "SKU-RL",
        bucket: "sellable",
        delta: 1,
        reason: "drip restock",
        idempotency_key: "k-6",
      });
      expect(denied.isError).toBe(true);
      const first = denied.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/Rate limited/i);
    });
  });
});
