import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { emitAuditRecord } from "@/lib/middleware/audit";
import {
  getOrSet,
  IDEMPOTENCY_DEFAULT_TTL_MS,
} from "@/lib/middleware/idempotency";
import { consume } from "@/lib/middleware/rate-limit";

/**
 * Flat auth context exposed to tool handlers. Built from `extra.authInfo`
 * by the registerTool wrapper so handlers don't have to redo the
 * Clerk-specific extraction every time.
 */
export interface AuthContext {
  userId: string | null;
  orgId: string | null;
  sessionId: string | null;
  scopes: string[];
  // SENSITIVE — inbound Clerk OAuth at+jwt forwarded to upstream APIs (V3b
  // same-IdP exchange pattern). M6 audit log redacts this field at the
  // pii-redact layer via the ALWAYS_REDACT_KEYS list (key "bearer" + "token"
  // + "jwt"); the AuthContext itself is never passed to redactArgs anyway.
  bearerToken: string | null;
}

/**
 * Per-tool guardrail configuration. OPT-IN: tools without a `guardrails`
 * field on their spec get no middleware behaviour change (compatibility
 * with the M2/M3 thin pass-through).
 *
 * M6 wires three behaviours, all gated by this object:
 *   - rateLimit: token-bucket on `{userId, tool}`. Denials short-circuit
 *     into an MCP error result with `isError: true` and a retry-hint string.
 *   - idempotency: if the handler args include a string under `keyArg`,
 *     wrap the handler in lib/middleware/idempotency.getOrSet so duplicate
 *     calls within TTL return the cached result.
 *   - audit: emit a structured JSON line on stdout (audit.ts). Defaults to
 *     TRUE whenever `guardrails` is set — turning audit off for a
 *     guardrailed tool would defeat the point. Set explicitly to `false`
 *     for read-only tools that don't merit the noise.
 *
 * Scope checks are NOT here — they're per-tool helpers, see
 * lib/middleware/scope.ts. The rationale is in that file's header.
 */
export interface GuardrailConfig {
  rateLimit?: {
    /** Max burst (= initial token count). */
    capacity: number;
    /** Sustained rate, tokens per second. */
    refillPerSec: number;
  };
  idempotency?: {
    /**
     * Name of the arg key the caller uses to supply an idempotency key.
     * If the arg is absent (or non-string), idempotency is skipped — the
     * handler runs unwrapped. This is deliberate: forcing every call to
     * supply a key would break LLM ergonomics on tools where the typical
     * call is one-shot anyway.
     */
    keyArg: string;
    /** Optional override; defaults to 15 minutes (idempotency.ts). */
    ttlMs?: number;
  };
  /** Default true when `guardrails` is set on the spec; pass false to suppress. */
  audit?: boolean;
}

/**
 * Typed tool specification. New tools export a `spec` of this shape and
 * register through `registerTool(server, spec)`. The wrapper is the
 * single chokepoint M6 layers guardrails into (rate-limit, idempotency,
 * audit). Output-size + schema enforcement remains TODO(M4).
 *
 * Output schema is carried on the spec for tests (e.g. asserting cassette
 * shape conformance via `spec.outputSchema.safeParse(cassette)`) but the
 * wrapper does NOT enforce it at runtime — M4 will add a warn-only
 * .safeParse pass.
 */
// TODO(M4): tighten `z.ZodObject<any>` to `z.ZodObject<z.ZodRawShape>` — same
// flexibility, no `any` escape hatch. Flagged in 2026-05-03 review.
export interface ToolSpec<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TInput extends z.ZodObject<any>,
  TOutput extends z.ZodTypeAny,
> {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  handler: (
    auth: AuthContext,
    args: z.infer<TInput>,
  ) => Promise<{
    // The full SDK content union, so tools can return text, image, resource,
    // or resource_link items — not just text. Widened 2026-05-14 in response
    // to `get_lastmile_order_label` returning 28KB base64 inside a text block,
    // which forced client LLMs into bash-heredoc gymnastics to decode bytes
    // that should have flowed as a `resource` block to begin with.
    content: ContentBlock[];
    isError?: boolean;
  }>;
  /** Opt-in guardrails. Absent = no middleware behaviour change. */
  guardrails?: GuardrailConfig;
}

/**
 * Build a tool-result payload from an upstream Quiqup HTTP error.
 *
 * The MCP wrapper catches `QuiqupHttpError` from any tool handler and
 * returns this shape so the LLM caller sees the *actual* rejection reason
 * (with `isError: true`) instead of an opaque RPC error. Without this, M3
 * thin pass-throughs surfaced only the bare status code — see 2026-05-14
 * bug report on `create_lastmile_order` repeatedly returning HTTP 422
 * with no field-level detail reaching the LLM.
 */
function quiqupErrorToToolResult(err: QuiqupHttpError): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const MAX_BODY = 4000;
  const body =
    err.body.length > MAX_BODY
      ? `${err.body.slice(0, MAX_BODY)} ...[truncated, original ${err.body.length} chars]`
      : err.body;

  let hint = "";
  if (err.status === 422 || err.status === 400) {
    hint =
      "This is a validation error from the upstream Quiqup API. " +
      "Inspect the body's `attribute_errors[].detail`, `error_details[].detail`, " +
      "or top-level `error` for the rejected field(s), then re-call with " +
      "corrected arguments. If the body provides only a `request_id` and no " +
      "field detail, the rejection is happening below the API gateway — escalate.";
  } else if (err.status === 401 || err.status === 403) {
    hint =
      "Authentication or permission issue. The exchanged session-JWT may be " +
      "expired or scope-insufficient for this operation/partner. Run `whoami_platform` " +
      "to confirm the JWT still resolves on platform-api.";
  } else if (err.status === 404) {
    hint = "Resource not found. Verify path parameters (order id, sku, etc.).";
  } else if (err.status >= 500) {
    hint = "Quiqup upstream temporarily unavailable. Retry in a few seconds.";
  }

  const text = [
    `Quiqup API returned HTTP ${err.status}.`,
    "",
    "Upstream response body:",
    body,
    hint ? "" : null,
    hint ? `Hint: ${hint}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * Build the composite key used by both rate-limit and idempotency caches.
 * Format is deliberately stable so log-grep can correlate audit records
 * with cache state: `${userId}:${tool}[:${idempKey}]`.
 */
function compositeKey(userId: string | null, tool: string, idempKey?: string): string {
  const u = userId ?? "anon";
  return idempKey === undefined ? `${u}:${tool}` : `${u}:${tool}:${idempKey}`;
}

// TODO(M4): output-schema enforcement. Currently `spec.outputSchema` is
// carried but the wrapper does not parse handler output against it. M4
// should add a warn-only `spec.outputSchema.safeParse(payload)` pass
// (don't throw — surface drift early without breaking prod). Flagged in
// 2026-05-03 review.
//
// TODO(verify): the `args as z.infer<TIn>` cast at the bottom of this
// function is a TRUST CAST — it's only sound if the SDK validates against
// `spec.inputSchema.shape` before calling the handler. If it doesn't,
// handlers receive raw `Record<string, unknown>` and the type promise is a
// lie. Verify mcp-handler's actual behavior (one wrapper-level test that
// pokes a registered tool with bad args). Flagged in 2026-05-03 review.
export function registerTool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TIn extends z.ZodObject<any>,
  TOut extends z.ZodTypeAny,
>(server: McpServer, spec: ToolSpec<TIn, TOut>): void {
  server.registerTool(
    spec.name,
    {
      title: spec.name,
      description: spec.description,
      // The SDK expects a raw {field: ZodType} shape map, not a wrapped
      // z.object(...). We carry the wrapped form on the spec for ergonomic
      // .safeParse() in tests; .shape unwraps it for the SDK.
      inputSchema: spec.inputSchema.shape,
    },
    async (
      args: Record<string, unknown>,
      extra: {
        authInfo?: {
          token?: string | null;
          scopes?: string[];
          extra?: unknown;
        };
      },
    ) => {
      const authInfo = extra.authInfo;
      // TODO(M6): unsafe type cast on extra.authInfo.extra — if Clerk
      // changes the shape under us, this silently produces null userId and
      // handlers proceed thinking they're unauthenticated. Add a runtime
      // sanity check (e.g. `if (clerkAuth && !clerkAuth.subject) throw`)
      // to fail loud on shape drift. Flagged in 2026-05-03 review.
      const clerkAuth = (
        authInfo?.extra as
          | {
              clerkAuth?: {
                subject?: string;
                orgId?: string | null;
                sessionId?: string | null;
                scopes?: string[];
              };
            }
          | undefined
      )?.clerkAuth;

      const auth: AuthContext = {
        userId: clerkAuth?.subject ?? null,
        orgId: clerkAuth?.orgId ?? null,
        sessionId: clerkAuth?.sessionId ?? null,
        scopes: clerkAuth?.scopes ?? authInfo?.scopes ?? [],
        bearerToken: authInfo?.token ?? null,
      };

      return invokeWithGuardrails(spec, auth, args);
    },
  );
}

/**
 * Inner orchestration: rate-limit → idempotency wrap → handler → error map
 *  → audit emit. Pulled out so unit tests can call it directly without
 * spinning up an McpServer.
 *
 * Exported as `_invokeForTests` rather than wired into the public surface
 * because the registerTool path is what production uses; tests just want
 * to validate the orchestration shape.
 */
async function invokeWithGuardrails<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TIn extends z.ZodObject<any>,
  TOut extends z.ZodTypeAny,
>(
  spec: ToolSpec<TIn, TOut>,
  auth: AuthContext,
  args: Record<string, unknown>,
): Promise<{ content: ContentBlock[]; isError?: boolean }> {
  const guardrails = spec.guardrails;
  const auditEnabled = guardrails ? guardrails.audit !== false : false;
  const start = Date.now();

  // 1. Rate-limit gate. Denial returns the MCP error result immediately
  //    AND is recorded in audit (the caller's pattern of hammering us is
  //    exactly what audit logs need to surface).
  if (guardrails?.rateLimit) {
    const rlKey = compositeKey(auth.userId, spec.name);
    const result = consume(
      rlKey,
      guardrails.rateLimit.capacity,
      guardrails.rateLimit.refillPerSec,
    );
    if (!result.allowed) {
      const retryAfter = result.retryAfterMs ?? 0;
      if (auditEnabled) {
        emitAuditRecord({
          userId: auth.userId,
          orgId: auth.orgId,
          tool: spec.name,
          args,
          idempotencyKey: extractIdempotencyKey(args, guardrails),
          durationMs: Date.now() - start,
          ok: false,
          error: `rate-limited; retry-after ${retryAfter}ms`,
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Rate limited; retry in ${retryAfter}ms`,
          },
        ],
        isError: true,
      };
    }
  }

  // 2. Idempotency wrap — but only if the caller actually supplied a key.
  //    Without a key we run the handler directly; this keeps tools usable
  //    without forcing every LLM call to invent a UUID.
  const idempKey = extractIdempotencyKey(args, guardrails);

  // 3. Build the actual handler execution as a closure so we can either
  //    invoke directly or via getOrSet.
  const runHandler = async (): Promise<{
    content: ContentBlock[];
    isError?: boolean;
  }> => {
    try {
      return await spec.handler(auth, args as z.infer<TIn>);
    } catch (err) {
      if (err instanceof QuiqupHttpError) {
        return quiqupErrorToToolResult(err);
      }
      throw err;
    }
  };

  let outcome: { content: ContentBlock[]; isError?: boolean };
  let outcomeError: string | undefined;
  try {
    if (guardrails?.idempotency && idempKey) {
      const ttl = guardrails.idempotency.ttlMs ?? IDEMPOTENCY_DEFAULT_TTL_MS;
      const cacheKey = compositeKey(auth.userId, spec.name, idempKey);
      outcome = await getOrSet(cacheKey, ttl, runHandler);
    } else {
      outcome = await runHandler();
    }
    if (outcome.isError) {
      outcomeError = "handler-returned-isError";
    }
  } catch (err) {
    // 4. Error path — always emit audit, then rethrow. We don't transform
    //    arbitrary errors into MCP results here (the SDK does its own
    //    JSON-RPC error mapping); we just make sure audit fires.
    if (auditEnabled) {
      emitAuditRecord({
        userId: auth.userId,
        orgId: auth.orgId,
        tool: spec.name,
        args,
        idempotencyKey: idempKey,
        durationMs: Date.now() - start,
        ok: false,
        error: (err as Error).message,
      });
    }
    throw err;
  }

  // 5. Success path (including isError: true returned from handler — that
  //    is a "structured failure" the LLM should see, not an exception).
  if (auditEnabled) {
    emitAuditRecord({
      userId: auth.userId,
      orgId: auth.orgId,
      tool: spec.name,
      args,
      idempotencyKey: idempKey,
      durationMs: Date.now() - start,
      ok: outcome.isError !== true,
      error: outcomeError,
    });
  }
  return outcome;
}

function extractIdempotencyKey(
  args: Record<string, unknown>,
  guardrails: GuardrailConfig | undefined,
): string | undefined {
  const keyArg = guardrails?.idempotency?.keyArg;
  if (!keyArg) return undefined;
  const v = args[keyArg];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Exported ONLY for unit tests in tests/register-tool.test.ts. Lets tests
 * exercise the guardrail orchestration without standing up an McpServer.
 * Not part of the public API; do not import from production code.
 */
export const _invokeWithGuardrailsForTests = invokeWithGuardrails;
