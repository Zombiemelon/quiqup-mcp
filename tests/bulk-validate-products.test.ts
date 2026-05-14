import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { _invokeWithGuardrailsForTests } from "@/lib/tools/register";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { AUDIT_PREFIX } from "@/lib/middleware/audit";

// Mock the JWT exchange so msw can intercept platform-api calls without
// touching real auth. Same shape used across the other fulfilment tests.
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

const validInput = {
  file_base64: "c2t1LG5hbWUKQUJDLEZvbw==", // "sku,name\nABC,Foo"
  filename: "products.csv",
};

// Capture stdout for audit assertions — audit.ts writes directly to
// process.stdout.write to avoid Next.js dev-mode source-map noise.
function captureStdout() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  return {
    auditLines: () => lines.filter((l) => l.startsWith(`${AUDIT_PREFIX} `)),
    restore: () => spy.mockRestore(),
  };
}

describe("bulk_validate_products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimit();
  });

  describe("registration", () => {
    it("registers under the expected name with required input schema", async () => {
      const mod = await import("../lib/tools/bulk-validate-products");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("bulk_validate_products");
      expect(mod.spec.description).toMatch(/bulk|validate/i);

      const result = mod.spec.inputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("description no longer carries disabled-pending-M6 language", async () => {
      const mod = await import("../lib/tools/bulk-validate-products");
      expect(mod.spec.description).not.toMatch(/disabled/i);
      expect(mod.spec.description).not.toMatch(/pending m6/i);
      // Cross-link to the two-phase partner is preserved.
      expect(mod.spec.description).toMatch(/bulk_commit_products/);
    });

    it("declares audit + rate-limit guardrails (no idempotency, no scope here)", async () => {
      const mod = await import("../lib/tools/bulk-validate-products");
      expect(mod.spec.guardrails).toBeDefined();
      expect(mod.spec.guardrails?.audit).toBe(true);
      expect(mod.spec.guardrails?.rateLimit).toMatchObject({ capacity: 20 });
      // Validation is naturally idempotent; no key needed.
      expect(mod.spec.guardrails?.idempotency).toBeUndefined();
    });
  });

  describe("input validation", () => {
    it("rejects missing file_base64", async () => {
      const mod = await import("../lib/tools/bulk-validate-products");
      const result = mod.spec.inputSchema.safeParse({ filename: "products.csv" });
      expect(result.success).toBe(false);
    });

    it("rejects empty file_base64", async () => {
      const mod = await import("../lib/tools/bulk-validate-products");
      const result = mod.spec.inputSchema.safeParse({
        file_base64: "",
        filename: "products.csv",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing filename", async () => {
      const mod = await import("../lib/tools/bulk-validate-products");
      const result = mod.spec.inputSchema.safeParse({ file_base64: "abc" });
      expect(result.success).toBe(false);
    });
  });

  describe("happy path — validation passed", () => {
    it("POSTs to /api/fulfilment/products/bulk/validate and surfaces the upload_id", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk/validate",
          () =>
            HttpResponse.json({
              upload_id: "UPL_ABC123",
              row_count: 5,
              errors: [],
            }),
        ),
      );
      const mod = await import("../lib/tools/bulk-validate-products");
      const result = await mod.spec.handler(auth, validInput);
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      // Header summary + JSON body.
      expect(first.text).toMatch(/Validation passed/i);
      expect(first.text).toContain("UPL_ABC123");
      expect(first.text).toContain("5 rows");
      // Cross-link to the commit phase is in the header.
      expect(first.text).toContain("bulk_commit_products");
    });
  });

  describe("happy path — validation found row errors", () => {
    it("surfaces row errors as a structured text block but NOT as isError", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk/validate",
          () =>
            HttpResponse.json({
              upload_id: "UPL_PARTIAL",
              row_count: 3,
              errors: [
                { row: 2, field: "selling_price", message: "must be a number" },
                { row: 3, field: "currency", message: "is required" },
              ],
            }),
        ),
      );
      const mod = await import("../lib/tools/bulk-validate-products");
      const result = await mod.spec.handler(auth, validInput);
      // Validation that finds errors is still a SUCCESSFUL tool call —
      // the LLM needs to see the rows in a normal content block.
      expect(result.isError).toBeFalsy();
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/2 row error/);
      expect(first.text).toContain("selling_price");
      expect(first.text).toContain("currency");
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError when upstream returns 422", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk/validate",
          () =>
            HttpResponse.json(
              { error: "invalid CSV header" },
              { status: 422 },
            ),
        ),
      );
      const mod = await import("../lib/tools/bulk-validate-products");
      await expect(mod.spec.handler(auth, validInput)).rejects.toThrow(
        QuiqupHttpError,
      );
      await expect(mod.spec.handler(auth, validInput)).rejects.toThrow(/422/);
    });
  });

  describe("guardrails — rate-limit smoke", () => {
    it("denies the 21st call within a 60s window via the wrapper", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk/validate",
          () => HttpResponse.json({ upload_id: "UPL_OK", row_count: 1, errors: [] }),
        ),
      );
      const mod = await import("../lib/tools/bulk-validate-products");
      // Capacity is 20 per the spec; the 21st should trip the bucket.
      for (let i = 0; i < 20; i++) {
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, validInput);
        expect(r.isError).toBeFalsy();
      }
      const denied = await _invokeWithGuardrailsForTests(
        mod.spec,
        auth,
        validInput,
      );
      expect(denied.isError).toBe(true);
      const first = denied.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toMatch(/Rate limited; retry in \d+ms/);
    });
  });

  describe("guardrails — audit emission", () => {
    it("emits a success audit record when the handler returns cleanly", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk/validate",
          () => HttpResponse.json({ upload_id: "UPL_OK", row_count: 1, errors: [] }),
        ),
      );
      const capture = captureStdout();
      try {
        const mod = await import("../lib/tools/bulk-validate-products");
        await _invokeWithGuardrailsForTests(mod.spec, auth, validInput);
        const audits = capture.auditLines();
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const json = JSON.parse(
          audits[audits.length - 1].slice(AUDIT_PREFIX.length + 1).trimEnd(),
        );
        expect(json).toMatchObject({
          tool: "bulk_validate_products",
          userId: "user_test",
          ok: true,
        });
      } finally {
        capture.restore();
      }
    });

    it("emits an ok:false audit record when the upstream returns 5xx (handler throws)", async () => {
      server.use(
        http.post(
          "https://platform-api.quiqup.com/api/fulfilment/products/bulk/validate",
          () => HttpResponse.json({ error: "boom" }, { status: 500 }),
        ),
      );
      const capture = captureStdout();
      try {
        const mod = await import("../lib/tools/bulk-validate-products");
        // 5xx → QuiqupHttpError → quiqupErrorToToolResult inside the wrapper
        // returns an isError:true result (NOT a thrown exception). Audit
        // records that path with ok:false via outcome.isError === true.
        const r = await _invokeWithGuardrailsForTests(mod.spec, auth, validInput);
        expect(r.isError).toBe(true);
        const audits = capture.auditLines();
        const json = JSON.parse(
          audits[audits.length - 1].slice(AUDIT_PREFIX.length + 1).trimEnd(),
        );
        expect(json.tool).toBe("bulk_validate_products");
        expect(json.ok).toBe(false);
      } finally {
        capture.restore();
      }
    });
  });
});
