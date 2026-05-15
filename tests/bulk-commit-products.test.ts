import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import {
  _invokeWithGuardrailsForTests,
  type AuthContext,
} from "@/lib/tools/register";

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

const validInput = {
  file_base64: "c2t1LG5hbWUKQUJDLEZvbw==",
  filename: "products.csv",
};

describe("bulk_commit_products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIdempotency();
    resetRateLimit();
  });

  describe("registration", () => {
    it("registers under the expected name with the expected input schema", async () => {
      const mod = await import("../lib/tools/bulk-commit-products");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("bulk_commit_products");
      expect(mod.spec.description).toMatch(/bulk|commit/i);
      // Description no longer carries the disabled-pending-M6 marker.
      expect(mod.spec.description).not.toMatch(/disabled/i);
      expect(mod.spec.description).not.toMatch(/pending M6/i);
      // Cross-reference to the validate phase remains in description guidance.
      expect(mod.spec.description).toMatch(/bulk_validate_products/);

      const result = mod.spec.inputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("declares guardrails: tight rate-limit, idempotency, audit on", async () => {
      const mod = await import("../lib/tools/bulk-commit-products");
      expect(mod.spec.guardrails).toBeDefined();
      expect(mod.spec.guardrails?.rateLimit?.capacity).toBe(2);
      // Roughly 2 tokens per minute.
      expect(mod.spec.guardrails?.rateLimit?.refillPerSec).toBeCloseTo(2 / 60);
      expect(mod.spec.guardrails?.idempotency?.keyArg).toBe("idempotency_key");
      // Longer-than-default TTL — bulk runs are slow.
      expect(mod.spec.guardrails?.idempotency?.ttlMs).toBe(30 * 60 * 1000);
      expect(mod.spec.guardrails?.audit).toBe(true);
    });
  });

  describe("input validation", () => {
    it("requires file_base64", async () => {
      const mod = await import("../lib/tools/bulk-commit-products");
      const r = mod.spec.inputSchema.safeParse({ filename: "products.csv" });
      expect(r.success).toBe(false);
    });

    it("requires filename", async () => {
      const mod = await import("../lib/tools/bulk-commit-products");
      const r = mod.spec.inputSchema.safeParse({
        file_base64: "c2t1LG5hbWUKQUJDLEZvbw==",
      });
      expect(r.success).toBe(false);
    });

    it("idempotency_key is optional", async () => {
      const mod = await import("../lib/tools/bulk-commit-products");
      const r = mod.spec.inputSchema.safeParse(validInput);
      expect(r.success).toBe(true);
      const r2 = mod.spec.inputSchema.safeParse({
        ...validInput,
        idempotency_key: "key-1",
      });
      expect(r2.success).toBe(true);
    });

    it("rejects non-string idempotency_key", async () => {
      const mod = await import("../lib/tools/bulk-commit-products");
      const r = mod.spec.inputSchema.safeParse({
        ...validInput,
        idempotency_key: 123,
      });
      expect(r.success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("POSTs to bulk_commit and returns a success summary", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk_commit",
          () =>
            HttpResponse.json({
              committed: 42,
              errors: [],
              upload_id: "UPL_OK",
            }),
        ),
      );
      const mod = await import("../lib/tools/bulk-commit-products");
      const result = await mod.spec.handler(auth, validInput);
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/42 row\(s\) committed/);
      expect(first.text).toContain("UPL_OK");
    });

    it("surfaces per-row errors in text without failing the overall call", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk_commit",
          () =>
            HttpResponse.json({
              committed: 8,
              errors: [
                { row: 3, sku: "BAD-SKU", message: "selling_price required" },
                { row: 7, sku: "DUP", message: "sku already exists" },
              ],
            }),
        ),
      );
      const mod = await import("../lib/tools/bulk-commit-products");
      const result = await mod.spec.handler(auth, validInput);
      expect(result.isError).toBeFalsy();
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/2 per-row error\(s\)/);
      expect(first.text).toContain("BAD-SKU");
      expect(first.text).toContain("selling_price required");
      expect(first.text).toContain("DUP");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on a 422 batch rejection", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk_commit",
          () =>
            HttpResponse.json(
              { error: "CSV header missing required column 'sku'" },
              { status: 422 },
            ),
        ),
      );
      const mod = await import("../lib/tools/bulk-commit-products");
      await expect(mod.spec.handler(auth, validInput)).rejects.toThrow(
        QuiqupHttpError,
      );
      await expect(mod.spec.handler(auth, validInput)).rejects.toThrow(/422/);
    });
  });

  describe("guardrails wiring (via registerTool wrapper)", () => {
    it("idempotency: same key + same body returns the cached result without re-calling upstream", async () => {
      let upstreamCalls = 0;
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk_commit",
          () => {
            upstreamCalls += 1;
            return HttpResponse.json({ committed: 1, errors: [] });
          },
        ),
      );
      const mod = await import("../lib/tools/bulk-commit-products");
      const args = { ...validInput, idempotency_key: "replay-key-A" };
      const r1 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      const r2 = await _invokeWithGuardrailsForTests(mod.spec, auth, args);
      expect(upstreamCalls).toBe(1);
      if (r1.content[0].type !== "text" || r2.content[0].type !== "text")
        throw new Error("expected text");
      expect(r2.content[0].text).toBe(r1.content[0].text);
    });

    it("rate-limit: 3rd call within the window is denied", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk_commit",
          () => HttpResponse.json({ committed: 1, errors: [] }),
        ),
      );
      const mod = await import("../lib/tools/bulk-commit-products");
      // Capacity = 2, so calls #1 and #2 pass, #3 denied.
      const r1 = await _invokeWithGuardrailsForTests(mod.spec, auth, validInput);
      const r2 = await _invokeWithGuardrailsForTests(mod.spec, auth, validInput);
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      const r3 = await _invokeWithGuardrailsForTests(mod.spec, auth, validInput);
      expect(r3.isError).toBe(true);
      const first = r3.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/Rate limited; retry in \d+ms/);
    });
  });
});
