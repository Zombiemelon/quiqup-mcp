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

describe("list_inbound_slots", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("registration", () => {
    it("registers under the expected name with empty input schema", async () => {
      const mod = await import("../lib/tools/list-inbound-slots");
      expect(mod.spec.name).toBe("list_inbound_slots");
      expect(mod.spec.description).toMatch(/slot/i);
      expect(mod.spec.inputSchema.safeParse({}).success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("strips extra unknown fields without erroring (strict zod object default)", async () => {
      const mod = await import("../lib/tools/list-inbound-slots");
      // empty object schema accepts and strips unknowns by default
      const result = mod.spec.inputSchema.safeParse({ bogus: 1 });
      expect(result.success).toBe(true);
    });

    it("rejects non-object input", async () => {
      const mod = await import("../lib/tools/list-inbound-slots");
      expect(mod.spec.inputSchema.safeParse("nope").success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns available slots", async () => {
      server.use(
        http.get(
          "https://platform-api.quiqup.com/api/fulfilment/slots/available",
          () => HttpResponse.json({ slots: [{ id: "slot-marker-3" }] }),
        ),
      );
      const mod = await import("../lib/tools/list-inbound-slots");
      const result = await mod.spec.handler(auth, {});
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      expect(first.text).toContain("slot-marker-3");
    });
  });
});
