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

describe("list_inbounds", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("registration", () => {
    it("registers under the expected name with optional input schema", async () => {
      const mod = await import("../lib/tools/list-inbounds");
      expect(mod.spec.name).toBe("list_inbounds");
      expect(mod.spec.description).toMatch(/inbound/i);
      expect(mod.spec.inputSchema.safeParse({}).success).toBe(true);
      expect(mod.spec.inputSchema.safeParse({ page: 2, per_page: 50 }).success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects non-int page", async () => {
      const mod = await import("../lib/tools/list-inbounds");
      expect(mod.spec.inputSchema.safeParse({ page: 1.5 }).success).toBe(false);
    });

    it("rejects oversize per_page", async () => {
      const mod = await import("../lib/tools/list-inbounds");
      expect(mod.spec.inputSchema.safeParse({ per_page: 500 }).success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns paginated inbounds list", async () => {
      server.use(
        http.get("https://platform-api.quiqup.com/api/fulfilment/inbounds", () =>
          HttpResponse.json({ items: [{ id: "inbound-marker-2" }] }),
        ),
      );
      const mod = await import("../lib/tools/list-inbounds");
      const result = await mod.spec.handler(auth, {});
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("inbound-marker-2");
    });
  });
});
