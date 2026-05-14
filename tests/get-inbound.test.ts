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

describe("get_inbound", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("registration", () => {
    it("registers under the expected name with required input schema", async () => {
      const mod = await import("../lib/tools/get-inbound");
      expect(mod.spec.name).toBe("get_inbound");
      expect(mod.spec.description).toMatch(/inbound/i);
      expect(mod.spec.inputSchema.safeParse({ inbound_id: "ib1" }).success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing inbound_id", async () => {
      const mod = await import("../lib/tools/get-inbound");
      const result = mod.spec.inputSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(["inbound_id"]);
    });

    it("rejects non-string inbound_id", async () => {
      const mod = await import("../lib/tools/get-inbound");
      expect(mod.spec.inputSchema.safeParse({ inbound_id: 1 }).success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns inbound detail", async () => {
      server.use(
        http.get(
          "https://platform-api.quiqup.com/api/fulfilment/inbound/ib1",
          () => HttpResponse.json({ id: "ib1", state: "state-marker-x" }),
        ),
      );
      const mod = await import("../lib/tools/get-inbound");
      const result = await mod.spec.handler(auth, { inbound_id: "ib1" });
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("state-marker-x");
    });
  });
});
