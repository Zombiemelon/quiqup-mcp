import { describe, it, expect, vi, beforeEach } from "vitest";

// Stable signing secret for tests. Must be ≥32 chars (lib/signed-url.ts).
process.env.LABEL_URL_SIGNING_SECRET =
  "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.NEXT_PUBLIC_APP_URL = "https://mcp.test.quiqup.com";

const auth = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["read"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

describe("get_lastmile_order_label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registration", () => {
    it("registers under the expected name with required input schema", async () => {
      const mod = await import("../lib/tools/get-lastmile-order-label");
      expect(mod.spec.name).toBe("get_lastmile_order_label");
      expect(mod.spec.description).toMatch(/label|pdf|url/i);

      const ok = mod.spec.inputSchema.safeParse({ order_id: "abc" });
      expect(ok.success).toBe(true);
    });
  });

  describe("input validation", () => {
    it("rejects missing order_id", async () => {
      const mod = await import("../lib/tools/get-lastmile-order-label");
      const result = mod.spec.inputSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["order_id"]);
      }
    });

    it("rejects empty order_id", async () => {
      const mod = await import("../lib/tools/get-lastmile-order-label");
      const result = mod.spec.inputSchema.safeParse({ order_id: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("happy path", () => {
    it("returns a text summary + resource_link pointing at the signed download URL", async () => {
      const orderId = "12345";

      const mod = await import("../lib/tools/get-lastmile-order-label");
      const result = await mod.spec.handler(auth, { order_id: orderId });

      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(2);

      const [summary, link] = result.content;
      if (summary.type !== "text") throw new Error("expected text summary");
      expect(summary.text).toMatch(new RegExp(`order_id=${orderId}`));
      // Don't leak the base64 PDF into the text channel any more.
      expect(summary.text).not.toMatch(/base64/i);

      if (link.type !== "resource_link")
        throw new Error("expected resource_link block");
      expect(link.mimeType).toBe("application/pdf");
      expect(link.name).toBe(`awb_${orderId}.pdf`);

      const parsed = new URL(link.uri);
      expect(parsed.origin).toBe("https://mcp.test.quiqup.com");
      expect(parsed.pathname).toBe(`/api/label/${orderId}`);
      expect(parsed.searchParams.get("u")).toBe(auth.userId);
      expect(parsed.searchParams.get("sig")).toBeTruthy();
      const exp = Number(parsed.searchParams.get("exp"));
      expect(Number.isFinite(exp)).toBe(true);
      // ~10 minutes (allow generous slack for slow runners).
      const skewSeconds = exp - Math.floor(Date.now() / 1000);
      expect(skewSeconds).toBeGreaterThan(9 * 60);
      expect(skewSeconds).toBeLessThanOrEqual(10 * 60 + 5);

      // The signed URL should match exactly between the two content blocks
      // so hosts that render either path land on the same download.
      expect(summary.text).toContain(link.uri);
    });

    it("encodes order ids with URL-unsafe characters", async () => {
      const orderId = "AB CD/123";
      const mod = await import("../lib/tools/get-lastmile-order-label");
      const result = await mod.spec.handler(auth, { order_id: orderId });
      const link = result.content[1];
      if (link.type !== "resource_link")
        throw new Error("expected resource_link block");
      const parsed = new URL(link.uri);
      // pathname is percent-encoded; decode and compare.
      expect(decodeURIComponent(parsed.pathname)).toBe(`/api/label/${orderId}`);
    });
  });

  describe("auth requirement", () => {
    it("throws if no userId is present on the auth context", async () => {
      const mod = await import("../lib/tools/get-lastmile-order-label");
      await expect(
        mod.spec.handler({ ...auth, userId: null }, { order_id: "abc" }),
      ).rejects.toThrow(/authenticated user/i);
    });
  });

  describe("output schema", () => {
    it("validates the {url, exp} shape", async () => {
      const mod = await import("../lib/tools/get-lastmile-order-label");
      const result = mod.spec.outputSchema.safeParse({
        url: "https://example.com/api/label/abc?u=user_test&exp=1&sig=xyz",
        exp: 1,
      });
      expect(result.success).toBe(true);
    });
  });
});
