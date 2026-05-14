import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import {
  assertOrderBelongsToUser,
  assertSkuBelongsToUser,
  ScopeViolationError,
} from "@/lib/middleware/scope";

// Mint a fake JWT — the real Clerk mint isn't exercised here; msw intercepts
// the upstream call at the fetch boundary.
vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async () => "scope-test-jwt"),
  };
});

describe("assertOrderBelongsToUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns without throwing when upstream returns 200", async () => {
    server.use(
      http.get("https://api-ae.quiqup.com/orders/:id", () =>
        HttpResponse.json({ order: { id: 1, state: "pending" } }),
      ),
    );
    await expect(
      assertOrderBelongsToUser("1", "user_owner"),
    ).resolves.toBeUndefined();
  });

  it("throws ScopeViolationError on upstream 404", async () => {
    server.use(
      http.get("https://api-ae.quiqup.com/orders/:id", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    await expect(
      assertOrderBelongsToUser("999", "user_other"),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("rejects when userId is missing (handler-level guard failure)", async () => {
    await expect(assertOrderBelongsToUser("1", "")).rejects.toThrow(
      /without a userId/,
    );
  });
});

describe("assertSkuBelongsToUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws ScopeViolationError on upstream 404", async () => {
    server.use(
      http.get(
        "https://platform-api.quiqup.com/api/fulfilment/products/:sku",
        () => HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    await expect(
      assertSkuBelongsToUser("SKU-X", "user_x"),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });
});
