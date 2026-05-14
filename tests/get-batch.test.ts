import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";

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

describe("get_batch", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("registration", () => {
    it("registers under the expected name with required input schema", async () => {
      const mod = await import("../lib/tools/get-batch");
      expect(mod.spec.name).toBe("get_batch");
      expect(mod.spec.description).toMatch(/batch/i);
      expect(mod.spec.inputSchema.safeParse({ batch_id: "b1" }).success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing batch_id", async () => {
      const mod = await import("../lib/tools/get-batch");
      const result = mod.spec.inputSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(["batch_id"]);
    });

    it("rejects non-string batch_id", async () => {
      const mod = await import("../lib/tools/get-batch");
      expect(mod.spec.inputSchema.safeParse({ batch_id: 1 }).success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns batch detail", async () => {
      server.use(
        http.get(
          "https://platform-api.quiqup.com/api/fulfilment/batches/b1",
          () => HttpResponse.json({ id: "b1", lot: "lot-marker-7" }),
        ),
      );
      const mod = await import("../lib/tools/get-batch");
      const result = await mod.spec.handler(auth, { batch_id: "b1" });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("lot-marker-7");
    });
  });
});
