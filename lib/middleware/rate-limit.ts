/**
 * Token-bucket rate limit, per `{userId, tool}`.
 *
 * Why this module exists: M6 wants a soft ceiling on write-tool call rate
 * per authenticated user. An LLM in a retry loop, or a misconfigured
 * client, could easily fire `cancel_lastmile_orders_batch` dozens of times
 * a minute — each one a real Quiqup API call with side-effects. The bucket
 * defaults are deliberately friendly (10 calls / 60s for write tools) —
 * this is a guardrail, not a throughput cap. Tools that need different
 * shapes pass a per-spec config.
 *
 * Token-bucket model: each bucket has a `capacity` (max burst) and a
 * `refillPerSec` (sustained rate). On each `consume` call we:
 *   1. compute how many tokens have accrued since the last check
 *   2. clamp to capacity
 *   3. if at least 1 token is available, take 1 and allow
 *   4. otherwise compute how long until the next token and return
 *      `retryAfterMs` so the caller can surface a useful message.
 *
 * Vercel cold-start caveat: same as idempotency — module-scoped Map of
 * buckets. Cold instance = fresh full bucket. Trade-off accepted: the
 * realistic abuse pattern is a runaway loop in a single warm conversation,
 * which the warm-instance bucket DOES catch. Cross-instance abuse from a
 * single attacker would need an upstream rate-limit (Vercel WAF or a
 * Redis-backed token bucket) — M7 territory.
 */

interface Bucket {
  /** Fractional token count; refilled lazily on consume. */
  tokens: number;
  /** epoch-ms of the last refill computation. */
  lastRefill: number;
  /** Cached for refill math. */
  capacity: number;
  refillPerSec: number;
}

const buckets = new Map<string, Bucket>();

export interface ConsumeResult {
  allowed: boolean;
  /** Present only when !allowed; ms until at least 1 token is available. */
  retryAfterMs?: number;
}

/**
 * Consume one token from the bucket identified by `key`. If the bucket
 * doesn't exist, it's created at full capacity.
 *
 * The bucket's `capacity` and `refillPerSec` are taken from the FIRST
 * caller — if a later call passes different values, the existing bucket's
 * params are updated to match. This keeps the per-tool config in
 * registerTool authoritative, even if it changes between deploys without
 * a cold start clearing the state.
 */
export function consume(
  key: string,
  capacity: number,
  refillPerSec: number,
): ConsumeResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now, capacity, refillPerSec };
    buckets.set(key, bucket);
  } else {
    // Refill: accrue tokens proportional to elapsed time, clamp to capacity.
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + elapsedSec * refillPerSec,
    );
    bucket.lastRefill = now;
    // Update config in case spec changed.
    bucket.capacity = capacity;
    bucket.refillPerSec = refillPerSec;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  // Not enough tokens. Compute time until the next whole token. Guard
  // against pathological refillPerSec=0 (would be a misconfiguration —
  // we degrade to a fixed "retry in 60s" rather than divide by zero).
  const deficit = 1 - bucket.tokens;
  const retryAfterMs =
    refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : 60_000;
  return { allowed: false, retryAfterMs };
}

/**
 * Test-only reset. Not part of the production API.
 */
export function _resetForTests(): void {
  buckets.clear();
}
