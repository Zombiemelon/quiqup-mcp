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

const mePayload = {
  id: "u_123",
  email: "csr@example.com",
  salesforce_id: "0035g000xyz",
  firstname: "Test",
  lastname: "User",
  display_name: "Test User",
  roles: ["csr"],
  core_api_user_id: 4242,
  admin: false,
  courier: false,
  csr: true,
  region_code: "uae.dubai",
};

describe("whoami_platform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("exposes a spec with the expected name and empty input schema", async () => {
      const mod = await import("../lib/tools/whoami-platform");
      expect(mod.spec).toBeDefined();
      expect(mod.spec.name).toBe("whoami_platform");
      expect(mod.spec.description).toMatch(/platform|identity|me/i);
      const r = mod.spec.inputSchema.safeParse({});
      expect(r.success).toBe(true);
    });
  });

  describe("happy path", () => {
    it("returns the /me payload as a text content block", async () => {
      server.use(
        http.get("https://platform-api.quiqup.com/me", () =>
          HttpResponse.json(mePayload),
        ),
      );

      const mod = await import("../lib/tools/whoami-platform");
      const result = await mod.spec.handler(auth, {});

      expect(result.content).toHaveLength(1);
      const first = result.content[0];
      if (first.type !== "text") throw new Error("expected text block");
      const parsed = JSON.parse(first.text);
      expect(parsed.core_api_user_id).toBe(4242);
      expect(parsed.region_code).toBe("uae.dubai");
      expect(parsed.roles).toEqual(["csr"]);
    });
  });

  describe("output schema", () => {
    it("validates the synthetic /me payload", async () => {
      const mod = await import("../lib/tools/whoami-platform");
      const r = mod.spec.outputSchema.safeParse(mePayload);
      expect(r.success).toBe(true);
    });
  });

  describe("error mapping", () => {
    it("throws QuiqupHttpError on 401", async () => {
      server.use(
        http.get("https://platform-api.quiqup.com/me", () =>
          HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
        ),
      );
      const mod = await import("../lib/tools/whoami-platform");
      const { QuiqupHttpError } = await import(
        "../lib/clients/quiqup-lastmile"
      );
      await expect(mod.spec.handler(auth, {})).rejects.toBeInstanceOf(
        QuiqupHttpError,
      );
    });
  });
});
