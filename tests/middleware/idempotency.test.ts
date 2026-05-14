import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getOrSet,
  _resetForTests,
  IDEMPOTENCY_DEFAULT_TTL_MS,
} from "@/lib/middleware/idempotency";

describe("getOrSet", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useRealTimers();
  });

  it("invokes compute on miss and returns its value", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { value: "first" };
    };
    const result = await getOrSet("k1", IDEMPOTENCY_DEFAULT_TTL_MS, compute);
    expect(result).toEqual({ value: "first" });
    expect(calls).toBe(1);
  });

  it("returns cached value on hit without re-invoking compute", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { value: calls };
    };
    const first = await getOrSet("k2", 60_000, compute);
    const second = await getOrSet("k2", 60_000, compute);
    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00Z"));

    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    await getOrSet("k3", 1_000, compute);
    vi.setSystemTime(new Date("2026-05-14T00:00:02Z")); // +2s, past TTL
    const v = await getOrSet("k3", 1_000, compute);
    expect(v).toBe(2);
    expect(calls).toBe(2);
  });

  it("does not cache failures (errors propagate without poisoning the slot)", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    };
    await expect(getOrSet("k4", 60_000, compute)).rejects.toThrow("boom 1");
    // Second call must re-invoke (not return cached failure).
    await expect(getOrSet("k4", 60_000, compute)).rejects.toThrow("boom 2");
  });

  it("evicts least-recently-used when over capacity", async () => {
    _resetForTests({ maxEntries: 3 });
    const compute = (label: string) => async () => label;

    await getOrSet("a", 60_000, compute("A"));
    await getOrSet("b", 60_000, compute("B"));
    await getOrSet("c", 60_000, compute("C"));
    // Touching "a" should move it to MRU position.
    await getOrSet("a", 60_000, compute("A2"));
    // Inserting "d" pushes us over capacity; oldest non-touched ("b") evicts.
    await getOrSet("d", 60_000, compute("D"));

    // "b" should re-run compute (cache miss); "a" should NOT.
    let aRan = false;
    await getOrSet("a", 60_000, async () => {
      aRan = true;
      return "A-fresh";
    });
    expect(aRan).toBe(false);

    let bRan = false;
    await getOrSet("b", 60_000, async () => {
      bRan = true;
      return "B-fresh";
    });
    expect(bRan).toBe(true);
  });

  it("concurrent callers de-duplicate against the in-flight compute", async () => {
    let calls = 0;
    let resolveCompute: (v: string) => void = () => {};
    const compute = () => {
      calls += 1;
      return new Promise<string>((r) => {
        resolveCompute = r;
      });
    };
    const p1 = getOrSet("k-concurrent", 60_000, compute);
    const p2 = getOrSet("k-concurrent", 60_000, compute);
    resolveCompute("done");
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1).toBe("done");
    expect(v2).toBe("done");
    expect(calls).toBe(1);
  });
});
