import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { consume, _resetForTests } from "@/lib/middleware/rate-limit";

describe("consume (token bucket)", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows up to `capacity` calls in a burst, then denies with retryAfterMs", () => {
    // 3-token bucket, 1 token / sec refill.
    for (let i = 0; i < 3; i++) {
      expect(consume("user1:tool", 3, 1)).toEqual({ allowed: true });
    }
    const denied = consume("user1:tool", 3, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // ~1s wait to recover one token at 1/sec.
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("recovers tokens after refill duration", () => {
    for (let i = 0; i < 3; i++) consume("u:t", 3, 1);
    expect(consume("u:t", 3, 1).allowed).toBe(false);

    // Advance 2 seconds → should have 2 tokens refilled (clamped to capacity).
    vi.setSystemTime(new Date("2026-05-14T00:00:02Z"));
    expect(consume("u:t", 3, 1).allowed).toBe(true);
    expect(consume("u:t", 3, 1).allowed).toBe(true);
    expect(consume("u:t", 3, 1).allowed).toBe(false);
  });

  it("keys buckets independently by composite key", () => {
    for (let i = 0; i < 3; i++) {
      expect(consume("userA:tool", 3, 1).allowed).toBe(true);
    }
    expect(consume("userA:tool", 3, 1).allowed).toBe(false);
    // Different user: fresh bucket.
    expect(consume("userB:tool", 3, 1).allowed).toBe(true);
  });

  it("degrades gracefully when refillPerSec is 0 (misconfiguration)", () => {
    expect(consume("misc:k", 1, 0).allowed).toBe(true);
    const denied = consume("misc:k", 1, 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(60_000);
  });
});
