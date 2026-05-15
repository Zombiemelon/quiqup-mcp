/**
 * Tool-surface snapshot eval.
 *
 * Closes a specific blind spot: the existing round-trip eval
 * (`evals/lastmile-order-roundtrip.ts`) bypasses the MCP transport
 * entirely — it hits `api.staging.quiqup.com` directly with OAuth2
 * client_credentials, so it can't tell you whether a tool was silently
 * flipped between "advertised + working" and "advertised + disabled
 * pending M6 guardrails". Seven write-side tools currently throw at the
 * handler level on purpose (see route.ts "Disabled pending M6" section
 * and the M6 guardrail design in lib/tools/register.ts TODOs). If any of
 * those flips back to enabled before the M6 work lands — or worse, an
 * enabled tool silently becomes disabled and stays advertised — we want
 * to find out at PR time, not at "merchant tried to use it" time.
 *
 * What this eval does:
 *
 *   1. Parse `app/[transport]/route.ts` to enumerate every tool that the
 *      server registers (`evals/datasets/tool-surface-v1.ts`). The list
 *      is derived programmatically; nothing here is hand-listed except
 *      the two legacy `register*` helpers that predate the spec pattern.
 *
 *   2. For each spec-style tool, dynamic-import its module and call the
 *      handler with a deliberately-empty auth context and empty args.
 *      Disabled handlers throw `Tool registered but disabled pending M6
 *      guardrails ...` regardless of inputs (they don't even consult
 *      `auth` or `args`). Enabled handlers either succeed or throw a
 *      different error (auth-required, network, validation). We classify
 *      on the thrown message — the M6 substring is the contract.
 *      Legacy `register*` tools are treated as statically enabled (they
 *      have no spec we can introspect, and they're read-only).
 *
 *   3. Compare the resulting `{toolName → "enabled" | "disabled-pending-m6"}`
 *      map against `evals/snapshots/tool-surface.json`. Differences are
 *      printed as a diff and — under `EVAL_GATE=1` — exit the process
 *      with code 1, matching the gate pattern used by the round-trip
 *      eval.
 *
 * Updating the baseline (when a flip is INTENTIONAL):
 *   - When M6 ships and a previously-disabled tool is re-enabled, OR
 *     when a new tool is added with an explicit M6 deferral, edit
 *     `evals/snapshots/tool-surface.json` in the SAME PR that flips the
 *     flag in `lib/tools/<tool>.ts` / `app/[transport]/route.ts`. The
 *     diff in the snapshot file is the documented record of intent —
 *     reviewers see the gate-flip in the same review as the code change.
 *   - For brand-new tools, just add the entry and the eval will pick up
 *     the registration from `route.ts` automatically.
 *
 * Why no LangFuse experiment harness (unlike other evals here):
 *   This eval has no model-in-the-loop component — it's a pure
 *   introspection + diff. Wrapping it in a LangFuse experiment would
 *   muddy the logs (no real "task" to evaluate). The fast-lane vitest
 *   mirror (`tests/tool-surface.test.ts`) covers PR runs; this script is
 *   the explicit-bun-run version humans use when they intentionally flip
 *   a flag and want to see the diff before committing the baseline.
 *
 * Run: `bun run eval:tool-surface`
 *      `EVAL_GATE=1 bun run eval:tool-surface`   (CI mode, exits 1 on diff)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolSurfaceSnapshot,
  type ToolStatus,
} from "./tool-surface-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, "snapshots", "tool-surface.json");

interface Diff {
  added: Array<{ name: string; status: ToolStatus }>;
  removed: Array<{ name: string; status: ToolStatus }>;
  changed: Array<{ name: string; from: ToolStatus; to: ToolStatus }>;
}

function diffSnapshots(
  baseline: Record<string, ToolStatus>,
  current: Record<string, ToolStatus>,
): Diff {
  const added: Diff["added"] = [];
  const removed: Diff["removed"] = [];
  const changed: Diff["changed"] = [];

  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  // Stable sort so the printed diff is deterministic across runs / OSes.
  for (const key of [...allKeys].sort()) {
    const b = baseline[key];
    const c = current[key];
    if (b === undefined && c !== undefined) {
      added.push({ name: key, status: c });
    } else if (c === undefined && b !== undefined) {
      removed.push({ name: key, status: b });
    } else if (b !== c) {
      changed.push({ name: key, from: b, to: c });
    }
  }
  return { added, removed, changed };
}

function printDiff(diff: Diff): void {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("Tool-surface snapshot matches baseline. No drift detected.");
    return;
  }
  console.log("Tool-surface snapshot diverges from baseline:");
  if (diff.added.length > 0) {
    console.log("\n  Added tools (in code, missing from baseline):");
    for (const e of diff.added) console.log(`    + ${e.name}  (${e.status})`);
  }
  if (diff.removed.length > 0) {
    console.log("\n  Removed tools (in baseline, missing from code):");
    for (const e of diff.removed) console.log(`    - ${e.name}  (was ${e.status})`);
  }
  if (diff.changed.length > 0) {
    console.log("\n  Flipped status (gate change — REQUIRES intentional baseline update):");
    for (const e of diff.changed) {
      console.log(`    ~ ${e.name}: ${e.from} → ${e.to}`);
    }
  }
  console.log(
    "\nIf this is INTENTIONAL (e.g. M6 guardrails shipped and a tool is now enabled):",
  );
  console.log(
    "  update evals/snapshots/tool-surface.json in the same PR. The snapshot is",
  );
  console.log("  the explicit record of intent for every gate flip.");
}

const baselineRaw = readFileSync(BASELINE_PATH, "utf8");
const baselineJson = JSON.parse(baselineRaw) as {
  tools: Record<string, ToolStatus>;
};
const baseline = baselineJson.tools;

const current = await buildToolSurfaceSnapshot();

// Pretty-print the actual snapshot so a human inspecting `bun run` output
// can copy it into the baseline if they intend to update it.
const currentSorted: Record<string, ToolStatus> = {};
for (const key of Object.keys(current).sort()) {
  currentSorted[key] = current[key];
}
console.log("Current tool-surface snapshot:");
console.log(JSON.stringify({ tools: currentSorted }, null, 2));
console.log();

const diff = diffSnapshots(baseline, current);
printDiff(diff);

const hasDrift =
  diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

if (hasDrift && process.env.EVAL_GATE === "1") {
  // Mirror evals/gate.ts: exit 1 in CI mode, no-op locally so a
  // developer can run the eval, eyeball the diff, then update the
  // baseline if intended.
  console.error("\nEVAL_GATE FAILED — tool-surface snapshot drifted from baseline.");
  process.exit(1);
}

if (hasDrift) {
  console.log(
    "\n(Run with EVAL_GATE=1 to exit non-zero on drift — that's how CI catches this.)",
  );
}
