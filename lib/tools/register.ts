import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";

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
  // same-IdP exchange pattern). TODO(M6): audit log must redact this field
  // when emitting per-call records. Flagged in 2026-05-03 review.
  bearerToken: string | null;
}

/**
 * Typed tool specification. New tools export a `spec` of this shape and
 * register through `registerTool(server, spec)`. The wrapper is the
 * single chokepoint M4 will layer guardrails into (output-size,
 * error-shape, redact, scope, rate-limit, audit). At M2 it's a thin
 * pass-through plus auth extraction.
 *
 * Output schema is carried on the spec for tests (e.g. asserting cassette
 * shape conformance via `spec.outputSchema.safeParse(cassette)`) but the
 * wrapper does NOT enforce it at runtime in M2 — M4 adds enforcement.
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
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
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

// TODO(M4): the wrapper itself has no unit tests. While it stays a thin
// pass-through that's borderline-fine, but M4 layers guardrails into this
// function — at that point the wrapper *must* have its own tests
// (registration roundtrip, auth extraction, output-schema enforcement,
// guardrail bypass attempts). Flagged in 2026-05-03 review.
//
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
      //
      // TODO(M4): also consider per-tool "auth required" enforcement. The
      // wrapper currently produces a fully-null AuthContext for unauth
      // requests; tools that *require* auth should fail closed at the
      // wrapper, not silently in the handler. Flagged in 2026-05-03 review.
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

      try {
        return await spec.handler(auth, args as z.infer<TIn>);
      } catch (err) {
        if (err instanceof QuiqupHttpError) {
          return quiqupErrorToToolResult(err);
        }
        throw err;
      }
    },
  );
}
