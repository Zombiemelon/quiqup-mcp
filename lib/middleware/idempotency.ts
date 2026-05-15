/**
 * In-memory idempotency cache for write-tool replay protection.
 *
 * Why this module exists: write tools (mark_ready_for_collection,
 * cancel_lastmile_orders_batch, …) are dangerous to replay — a duplicate
 * call could double-bill the merchant or re-dispatch a cancelled order.
 * MCP transport doesn't (yet) give us a request id we can trust for
 * deduplication, so the contract is: the caller supplies an
 * `idempotency_key` in args, and we cache the result for a short window
 * keyed by `{userId, tool, idempotency_key}`.
 *
 * Vercel cold-start caveat: this cache is a module-scoped Map. Serverless
 * function instances are created on demand and disappear when idle. So:
 *   - Replay arriving < seconds after the original, same warm instance:
 *     → de-duplicated. This is the common LLM-retry pattern.
 *   - Replay arriving after the instance went cold (~minutes idle) or
 *     against a different deployed instance:
 *     → NOT de-duplicated. The original args + key combo would hit the
 *     upstream Quiqup API again.
 *
 * That's acceptable for "near-duplicate within seconds" replay protection,
 * which is the realistic LLM-retry threat model. It is NOT acceptable for
 * cross-deploy idempotency guarantees. M7 hand-off: swap the Map for a
 * Redis or Upstash client; the getOrSet shape stays the same, only the
 * storage changes. The seven write tools wired against this in Wave 2 will
 * not need to change when M7 lands.
 *
 * LRU eviction: bounded at 1000 entries so a misbehaving caller can't
 * exhaust the function's memory. The Map preserves insertion order in
 * JavaScript, so we use insertion-order = approximate LRU; on every read,
 * we delete + re-insert to bump the key to most-recently-used.
 */

interface CacheEntry<T> {
  value: T;
  /** Absolute epoch-ms when the entry stops being valid. */
  exp: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Module-scoped store. Keyed by the composite key built by the caller —
// `${userId}:${tool}:${idempotency_key}` is the convention used by
// registerTool, but the cache itself doesn't care.
const store = new Map<string, CacheEntry<unknown>>();

/** Test-only knobs; not exported in the barrel. Reset in tests via resetForTests(). */
let maxEntries = DEFAULT_MAX_ENTRIES;

/**
 * Cache the result of `compute()` under `key` for `ttlMs`; on a subsequent
 * call with the same key (before expiry) return the cached value WITHOUT
 * invoking `compute` again.
 *
 * The compute function is awaited *while holding a placeholder in the
 * cache* — this is intentional. Without it, two concurrent calls with the
 * same key would both fire upstream before either could populate the
 * cache, defeating the point. We implement the placeholder as a stored
 * Promise; the second caller awaits the same promise.
 */
export async function getOrSet<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && existing.exp > now) {
    // Bump to most-recently-used by deleting + re-inserting.
    store.delete(key);
    store.set(key, existing);
    return existing.value as T;
  }
  if (existing) {
    // Expired entry — drop it and fall through.
    store.delete(key);
  }

  // Place a Promise in the cache so concurrent callers de-duplicate against
  // the in-flight compute(). We store the promise as the value; resolves
  // are then unwrapped by the caller via await. Both arms of the cache hit
  // path therefore return `T` after await.
  const inFlight = compute();
  const placeholder: CacheEntry<Promise<T>> = {
    value: inFlight,
    exp: now + ttlMs,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.set(key, placeholder as unknown as CacheEntry<any>);

  // LRU evict if we're over capacity. Map iteration is insertion-order,
  // so the first key is the oldest.
  while (store.size > maxEntries) {
    const firstKey = store.keys().next().value;
    if (firstKey === undefined) break;
    store.delete(firstKey);
  }

  try {
    const resolved = await inFlight;
    // Replace the placeholder with the resolved value so future hits skip
    // the await and return synchronously through the cached value path.
    store.set(key, { value: resolved, exp: now + ttlMs });
    return resolved;
  } catch (err) {
    // Don't cache failures — a transient upstream 5xx should not poison
    // the cache for 15 minutes. Drop the entry and rethrow.
    store.delete(key);
    throw err;
  }
}

/**
 * Test-only reset. NOT exported through any production barrel. Used to
 * isolate tests so module-scoped state doesn't bleed across cases.
 */
export function _resetForTests(opts?: { maxEntries?: number }): void {
  store.clear();
  maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
}

/** Default TTL exported so tools can omit a value and inherit the policy. */
export const IDEMPOTENCY_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
