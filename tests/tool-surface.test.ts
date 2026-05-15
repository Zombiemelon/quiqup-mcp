/**
 * Tool-surface snapshot gate — fast-lane vitest mirror of
 * `evals/tool-surface.ts`.
 *
 * This test exists for one reason: catch a silent flip of any tool's
 * disabled-pending-M6 flag in CI on every PR, without waiting for the
 * explicit `bun run eval:tool-surface` step. The eval script and this
 * test share the same snapshot-builder (`evals/tool-surface-shared.ts`)
 * and the same baseline file (`evals/snapshots/tool-surface.json`), so
 * "the test passed in CI" and "the eval passed locally" mean the same
 * thing — there is no second source of truth.
 *
 * When this test fails, the failure message is the diff. Read it:
 *
 *   - "Flipped status" means a tool moved between enabled and
 *     disabled-pending-m6. This is the M6 regression the gate was
 *     designed for. If it's intentional (M6 guardrails shipped, or a
 *     new tool was added with an explicit deferral), update
 *     `evals/snapshots/tool-surface.json` in the same PR.
 *
 *   - "Added tools" / "Removed tools" mean route.ts gained or lost a
 *     registration. Same rule: update the baseline alongside the
 *     registration change so the snapshot diff is part of the PR
 *     review.
 *
 * Do NOT make this test "self-healing" by writing the current snapshot
 * back to disk on failure. The whole point is that the baseline is a
 * tracked, human-reviewed artifact.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolSurfaceSnapshot,
  type ToolStatus,
} from "../evals/tool-surface-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, "..", "evals", "snapshots", "tool-surface.json");

describe("tool-surface snapshot", () => {
  it("matches the committed baseline (gates M6 disabled-flag flips)", async () => {
    const baselineRaw = readFileSync(BASELINE_PATH, "utf8");
    const baseline = (
      JSON.parse(baselineRaw) as { tools: Record<string, ToolStatus> }
    ).tools;

    const current = await buildToolSurfaceSnapshot();

    // Equality on the whole map is what we want — added/removed/flipped
    // tools all surface as a single readable diff in vitest output.
    expect(current).toEqual(baseline);
  });

  it("baseline contains no disabled-pending-m6 entries (M6 shipped)", () => {
    // Anchor test: independent of the snapshot-builder, this asserts
    // the current count of M6-deferred tools. M6 guardrails (audit,
    // scope, idempotency, rate-limit) shipped and all seven previously
    // disabled write tools (adjust_stock, book_inbound_slot,
    // bulk_commit_products, bulk_validate_products,
    // cancel_lastmile_orders_batch, mark_ready_for_collection,
    // remove_parcel_from_order) were re-enabled. Update this literal if
    // a new tool is added and deferred to a later milestone.
    const baselineRaw = readFileSync(BASELINE_PATH, "utf8");
    const baseline = (
      JSON.parse(baselineRaw) as { tools: Record<string, ToolStatus> }
    ).tools;
    const disabled = Object.entries(baseline)
      .filter(([, status]) => status === "disabled-pending-m6")
      .map(([name]) => name);
    expect(disabled.sort()).toEqual([]);
  });
});
