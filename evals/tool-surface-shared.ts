/**
 * Shared snapshot builder for the tool-surface gate.
 *
 * Used by both `evals/tool-surface.ts` (humans, explicit bun run) and
 * `tests/tool-surface.test.ts` (CI fast-lane, every PR). Kept inside
 * `evals/` so the rule "only evals/**, tests/tool-surface.test.ts, and
 * package.json may change" is honoured.
 *
 * Classification contract (the substring is load-bearing):
 *   - A spec-style tool is "disabled-pending-m6" iff calling its handler
 *     throws an Error whose message includes the canonical M6 marker
 *     string (see DISABLED_MARKER below). All 7 currently-disabled
 *     handlers throw this exact substring before consulting auth or args
 *     — they're literally `async () => { throw new Error("Tool registered
 *     but disabled pending M6 guardrails ...") }` — so we can detect
 *     them deterministically without ever validating inputs.
 *   - Everything else is "enabled". An enabled tool may also throw when
 *     called with empty auth/args (auth-required, validation, network),
 *     but the thrown message will NOT contain the M6 marker.
 *
 * Why we don't run input-schema validation first: a few disabled tools
 * (e.g. mark_ready_for_collection, remove_parcel_from_order, adjust_stock)
 * have non-trivial input schemas. We want to detect that they're disabled
 * *regardless* of whether the schema would accept empty args, so we
 * bypass validation and call the handler directly. This is safe because
 * disabled handlers throw on the first line.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadToolRegistrations,
  resolveToolNames,
  type ToolRegistration,
} from "./datasets/tool-surface-v1";

export type ToolStatus = "enabled" | "disabled-pending-m6";

/**
 * Canonical marker emitted by every disabled handler. If you're editing
 * this string you almost certainly want to update the handlers in
 * `lib/tools/<tool>.ts` instead — they're the source of truth and this
 * marker is just the contract between handler and snapshot-builder.
 */
const DISABLED_MARKER = "disabled pending M6 guardrails";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * Synthetic auth context with all-nulls. Disabled handlers throw before
 * touching `auth`, so the contents don't matter for them. For enabled
 * handlers that *do* consult auth, null fields cause an auth-required
 * throw early — avoids any accidental network traffic from the
 * snapshot-build step.
 */
const SYNTHETIC_AUTH = {
  userId: null,
  orgId: null,
  sessionId: null,
  scopes: [],
  bearerToken: null,
} as const;

async function classifyToolStatus(
  registration: ToolRegistration,
): Promise<ToolStatus> {
  if (registration.modulePath === null) {
    // Legacy register*() tools (claims_dump, recent_orders) — no spec
    // module, statically enabled, not part of the M6 deferral set.
    return "enabled";
  }
  const abs = resolve(REPO_ROOT, registration.modulePath);
  const mod = (await import(abs)) as {
    spec?: {
      name?: string;
      description?: string;
      handler?: (auth: unknown, args: unknown) => Promise<unknown>;
    };
  };
  const handler = mod.spec?.handler;
  if (typeof handler !== "function") {
    throw new Error(
      `tool-surface: ${registration.modulePath} exports no spec.handler — ` +
        "every spec-style tool must expose a callable handler.",
    );
  }

  try {
    // Intentionally pass `{}` (untyped) to bypass any handler-level args
    // expectations. Disabled handlers ignore args and throw immediately;
    // enabled handlers will throw on missing auth before touching args.
    await handler(SYNTHETIC_AUTH, {} as never);
    // If it actually returned, the tool is enabled. (Unlikely with
    // null-auth, but treat success as enabled.)
    return "enabled";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(DISABLED_MARKER)) {
      return "disabled-pending-m6";
    }
    // Fallback heuristic per the task brief: if a tool's description
    // explicitly carries a DISABLED-PENDING-M6 tag but the handler
    // somehow didn't throw the marker, still classify as disabled.
    // Defensive — none of the current 7 hit this path, but it
    // future-proofs against handler refactors that drop the marker.
    const desc = mod.spec?.description ?? "";
    if (desc.includes("DISABLED-PENDING-M6")) {
      return "disabled-pending-m6";
    }
    return "enabled";
  }
}

/**
 * Build the full `{toolName → status}` snapshot. Keys are stable-sorted
 * by name so JSON serialisation is byte-identical across runs / OSes —
 * a prerequisite for using the baseline file as a review artifact.
 */
export async function buildToolSurfaceSnapshot(): Promise<Record<string, ToolStatus>> {
  const registrations = loadToolRegistrations();
  const named = await resolveToolNames(registrations);

  const pairs: Array<[string, ToolStatus]> = [];
  for (let i = 0; i < registrations.length; i++) {
    const status = await classifyToolStatus(registrations[i]);
    pairs.push([named[i].name, status]);
  }

  // Detect duplicate tool names — would be a config bug in route.ts
  // (same spec imported twice) and we want to fail loud, not let the
  // later entry silently win.
  const seen = new Set<string>();
  for (const [name] of pairs) {
    if (seen.has(name)) {
      throw new Error(`tool-surface: duplicate tool name registered: ${name}`);
    }
    seen.add(name);
  }

  const sorted = pairs.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sorted);
}
