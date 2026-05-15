/**
 * tool-surface-v1 — programmatic registry of every tool advertised by the
 * Quiqup MCP server.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the surface-snapshot eval
 * (`evals/tool-surface.ts`) and its fast-lane vitest mirror
 * (`tests/tool-surface.test.ts`). It does NOT hand-list tool names — it
 * derives them by parsing `app/[transport]/route.ts` so the dataset cannot
 * drift from what the server actually advertises on `tools/list`.
 *
 * Why a parsed registry (not a runtime introspection of the live server):
 *   - We don't want the eval to spin up a Next.js handler or hit the
 *     network — it must be cheap enough to run on every PR via vitest.
 *   - `createMcpHandler` wraps the registration callback opaquely; there's
 *     no public hook to enumerate registered tools without binding to
 *     mcp-handler internals that may break across versions.
 *   - Text-parsing `route.ts` is fragile-but-honest: if the file changes
 *     shape in a way the regex misses, this module will silently miss a
 *     tool and the eval baseline will tell us about it on the next run.
 *
 * Two registration patterns appear in `route.ts`:
 *   1. Spec-style:    `registerTool(server, <name>Spec)` paired with
 *      `import { spec as <name>Spec } from "@/lib/tools/<file>"`.
 *   2. Legacy-style:  `registerClaimsDump(server)` / `registerRecentOrders(server)`
 *      — older tools that predate the ToolSpec abstraction. They expose no
 *      `spec` export, so we map them to their advertised tool name
 *      explicitly. This is the ONLY hand-mapping in this file; it's
 *      narrowly scoped to legacy register*() helpers and guarded by an
 *      explicit registration-presence check on the source file.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// __dirname-equivalent for ESM. Anchoring on this file keeps the paths
// stable regardless of where `bun run` / `vitest` resolve `cwd` from.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ROUTE_PATH = resolve(REPO_ROOT, "app", "[transport]", "route.ts");

/**
 * Legacy register*() helpers that don't expose a `spec` export. We map
 * them to (a) their advertised tool name and (b) a static "enabled"
 * status — these are diagnostic/read-only tools, not part of the M6 gate.
 *
 * If you add a new legacy register*() helper to route.ts, ADD IT HERE.
 * The route-file presence check below will fail loud if a legacy entry
 * declared here isn't actually registered in route.ts (catches stale
 * entries when a legacy tool is migrated to the spec pattern or removed).
 */
const LEGACY_REGISTRATIONS: ReadonlyArray<{
  registerFn: string;
  toolName: string;
}> = [
  { registerFn: "registerClaimsDump", toolName: "claims_dump" },
  { registerFn: "registerRecentOrders", toolName: "recent_orders" },
];

export interface ToolRegistration {
  /** Tool name as advertised on `tools/list` (snake_case, matches `spec.name`). */
  name: string;
  /**
   * For spec-style registrations: dynamic-import path relative to repo root
   * (e.g. `lib/tools/adjust-stock`). For legacy registrations: null —
   * there's no spec module to introspect, and the eval treats these as
   * statically enabled.
   */
  modulePath: string | null;
}

/**
 * Parse `app/[transport]/route.ts` and return one entry per registered tool.
 * Order is deterministic: spec-style registrations follow the order of
 * `registerTool(server, X)` calls in the file; legacy registrations are
 * appended in `LEGACY_REGISTRATIONS` order. Callers that need a stable
 * snapshot key should sort by `.name` themselves.
 */
export function loadToolRegistrations(): ToolRegistration[] {
  const src = readFileSync(ROUTE_PATH, "utf8");

  // Map `<varName>` → `@/lib/tools/<file>` from `import { spec as <varName> } from "..."` lines.
  // Allow whitespace/multiline variations in case route.ts is reformatted.
  const importRe =
    /import\s*\{\s*spec\s+as\s+(\w+)\s*\}\s*from\s*["']@\/lib\/tools\/([^"']+)["']\s*;?/g;
  const specVarToPath = new Map<string, string>();
  for (const m of src.matchAll(importRe)) {
    specVarToPath.set(m[1], `lib/tools/${m[2]}`);
  }

  // Pull every `registerTool(server, <varName>)` call. Whitespace-tolerant.
  const registerRe = /registerTool\s*\(\s*server\s*,\s*(\w+)\s*\)\s*;?/g;
  const registeredVars: string[] = [];
  for (const m of src.matchAll(registerRe)) {
    registeredVars.push(m[1]);
  }

  // Resolve each registered spec var to its module path. Bail loud on
  // dangling references (registerTool with no matching import) so the
  // failure mode is a clear error, not a silently-skipped tool.
  const specEntries: ToolRegistration[] = registeredVars.map((varName) => {
    const modulePath = specVarToPath.get(varName);
    if (!modulePath) {
      throw new Error(
        `tool-surface dataset: registerTool(server, ${varName}) in route.ts ` +
          `has no matching \`import { spec as ${varName} } from "@/lib/tools/..."\`. ` +
          "Did the import line move or rename?",
      );
    }
    // We resolve the tool *name* lazily by dynamic-importing the module —
    // see `loadToolNames()`. We can't statically know the name here
    // without executing the module, and we want the dataset itself to be
    // import-side-effect-free.
    return { name: varName, modulePath };
  });

  // Legacy register*() helpers: verify each declared entry is *actually*
  // wired up in route.ts. If a legacy helper is removed from route.ts
  // (e.g. migrated to the spec pattern), this throws so the dataset can't
  // silently advertise a tool that's no longer registered.
  const legacyEntries: ToolRegistration[] = LEGACY_REGISTRATIONS.map(
    ({ registerFn, toolName }) => {
      const callRe = new RegExp(`\\b${registerFn}\\s*\\(\\s*server\\s*\\)`);
      if (!callRe.test(src)) {
        throw new Error(
          `tool-surface dataset: legacy registration \`${registerFn}(server)\` is ` +
            `declared in LEGACY_REGISTRATIONS but not found in route.ts. ` +
            "Remove the entry or restore the registration.",
        );
      }
      return { name: toolName, modulePath: null };
    },
  );

  return [...specEntries, ...legacyEntries];
}

/**
 * Resolve each spec-style entry's actual tool name by dynamic-importing
 * its module and reading `spec.name`. Legacy entries already carry the
 * advertised name and pass through unchanged.
 *
 * Kept as a separate step (rather than baked into `loadToolRegistrations`)
 * so the lightweight registry can be inspected synchronously in tests
 * that don't need handler introspection.
 */
export async function resolveToolNames(
  registrations: ToolRegistration[],
): Promise<Array<{ name: string; modulePath: string | null }>> {
  const out: Array<{ name: string; modulePath: string | null }> = [];
  for (const reg of registrations) {
    if (reg.modulePath === null) {
      out.push({ name: reg.name, modulePath: null });
      continue;
    }
    // Path is repo-relative (e.g. `lib/tools/adjust-stock`); resolve to
    // absolute for dynamic import. `@/` alias isn't available at runtime
    // outside Next.js, so we go via the filesystem path.
    const abs = resolve(REPO_ROOT, reg.modulePath);
    const mod = (await import(abs)) as { spec?: { name?: string } };
    const advertisedName = mod.spec?.name;
    if (!advertisedName || typeof advertisedName !== "string") {
      throw new Error(
        `tool-surface dataset: ${reg.modulePath} exports no \`spec.name\` (got ${
          JSON.stringify(advertisedName)
        }). Every spec-style tool must export a string \`spec.name\`.`,
      );
    }
    out.push({ name: advertisedName, modulePath: reg.modulePath });
  }
  return out;
}
