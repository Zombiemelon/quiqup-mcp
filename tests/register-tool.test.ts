import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  _invokeWithGuardrailsForTests,
  type AuthContext,
  type ToolSpec,
} from "@/lib/tools/register";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { AUDIT_PREFIX } from "@/lib/middleware/audit";

/**
 * Integration-style test for registerTool's guardrail wiring. Exercises
 * rate-limit + idempotency + audit against a stub spec, capturing stdout
 * for audit assertions.
 *
 * We don't spin up an McpServer here — invokeWithGuardrails is the unit
 * under test, and the McpServer pathway is just `server.registerTool(...)`
 * forwarding into it after Clerk extraction. The forward is verified by
 * the existing per-tool tests (they call spec.handler directly today;
 * after Wave 2 they'll go through invokeWithGuardrails too).
 */

const auth: AuthContext = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["read"],
  bearerToken: "token-unused",
};

function captureStdout() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  return {
    auditLines: () =>
      lines.filter((l) => l.startsWith(`${AUDIT_PREFIX} `)),
    restore: () => spy.mockRestore(),
  };
}

const inputSchema = z.object({
  order_id: z.string(),
  idempotency_key: z.string().optional(),
});
const outputSchema = z.object({}).passthrough();

function makeSpec(
  handler: ToolSpec<typeof inputSchema, typeof outputSchema>["handler"],
  guardrails?: ToolSpec<typeof inputSchema, typeof outputSchema>["guardrails"],
): ToolSpec<typeof inputSchema, typeof outputSchema> {
  return {
    name: "stub_tool",
    description: "stub",
    inputSchema,
    outputSchema,
    handler,
    guardrails,
  };
}

describe("registerTool guardrails wiring", () => {
  let capture: ReturnType<typeof captureStdout>;
  beforeEach(() => {
    resetIdempotency();
    resetRateLimit();
    capture = captureStdout();
  });
  afterEach(() => capture.restore());

  it("passes through unchanged when guardrails is absent (no audit, no rate-limit)", async () => {
    let calls = 0;
    const spec = makeSpec(async () => {
      calls += 1;
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    const r = await _invokeWithGuardrailsForTests(spec, auth, {
      order_id: "1",
    });
    expect(r.content[0]).toEqual({ type: "text", text: "ok" });
    expect(calls).toBe(1);
    // No audit line when guardrails is undefined.
    expect(capture.auditLines()).toHaveLength(0);
  });

  it("emits an audit record on success when guardrails set", async () => {
    const spec = makeSpec(
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      { audit: true },
    );
    await _invokeWithGuardrailsForTests(spec, auth, { order_id: "1" });
    const audits = capture.auditLines();
    expect(audits).toHaveLength(1);
    const json = JSON.parse(audits[0].slice(AUDIT_PREFIX.length + 1).trimEnd());
    expect(json).toMatchObject({
      tool: "stub_tool",
      userId: "user_test",
      ok: true,
    });
  });

  it("emits ok:false audit record when handler throws", async () => {
    const spec = makeSpec(
      async () => {
        throw new Error("handler-broke");
      },
      { audit: true },
    );
    await expect(
      _invokeWithGuardrailsForTests(spec, auth, { order_id: "1" }),
    ).rejects.toThrow("handler-broke");
    const audits = capture.auditLines();
    expect(audits).toHaveLength(1);
    const json = JSON.parse(audits[0].slice(AUDIT_PREFIX.length + 1).trimEnd());
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/handler-broke/);
  });

  it("rate-limit denies the 4th call when capacity=3 and emits an audit record for the denial", async () => {
    const spec = makeSpec(
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      { rateLimit: { capacity: 3, refillPerSec: 0.01 } },
    );
    for (let i = 0; i < 3; i++) {
      const r = await _invokeWithGuardrailsForTests(spec, auth, {
        order_id: String(i),
      });
      expect(r.isError).toBeFalsy();
    }
    const denied = await _invokeWithGuardrailsForTests(spec, auth, {
      order_id: "4",
    });
    expect(denied.isError).toBe(true);
    const first = denied.content[0];
    if (first.type !== "text") throw new Error("expected text block");
    expect(first.text).toMatch(/Rate limited; retry in \d+ms/);

    // 4 success audits + 1 denial audit (audit defaults to true with guardrails set).
    const audits = capture.auditLines();
    expect(audits).toHaveLength(4);
    const lastJson = JSON.parse(
      audits[3].slice(AUDIT_PREFIX.length + 1).trimEnd(),
    );
    expect(lastJson.ok).toBe(false);
    expect(lastJson.error).toMatch(/rate-limited/);
  });

  it("idempotency caches the handler result by keyArg", async () => {
    let calls = 0;
    const spec = makeSpec(
      async () => {
        calls += 1;
        return {
          content: [{ type: "text" as const, text: `call-${calls}` }],
        };
      },
      { idempotency: { keyArg: "idempotency_key" } },
    );
    const r1 = await _invokeWithGuardrailsForTests(spec, auth, {
      order_id: "1",
      idempotency_key: "abc",
    });
    const r2 = await _invokeWithGuardrailsForTests(spec, auth, {
      order_id: "1",
      idempotency_key: "abc",
    });
    expect(calls).toBe(1);
    if (r1.content[0].type !== "text" || r2.content[0].type !== "text")
      throw new Error("expected text");
    expect(r1.content[0].text).toBe("call-1");
    expect(r2.content[0].text).toBe("call-1");
  });

  it("idempotency is skipped when the keyArg is absent from args", async () => {
    let calls = 0;
    const spec = makeSpec(
      async () => {
        calls += 1;
        return { content: [{ type: "text" as const, text: `call-${calls}` }] };
      },
      { idempotency: { keyArg: "idempotency_key" } },
    );
    await _invokeWithGuardrailsForTests(spec, auth, { order_id: "1" });
    await _invokeWithGuardrailsForTests(spec, auth, { order_id: "1" });
    expect(calls).toBe(2);
  });

  it("audit can be suppressed by audit:false even when guardrails is set", async () => {
    const spec = makeSpec(
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      { rateLimit: { capacity: 10, refillPerSec: 1 }, audit: false },
    );
    await _invokeWithGuardrailsForTests(spec, auth, { order_id: "1" });
    expect(capture.auditLines()).toHaveLength(0);
  });

  it("audit args are redacted before emission (regression: never log PII)", async () => {
    const spec = makeSpec(
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      { audit: true },
    );
    await _invokeWithGuardrailsForTests(
      spec,
      auth,
      // Cast through unknown because the inputSchema doesn't declare these
      // PII fields — but the wrapper still redacts whatever it gets.
      { order_id: "1", recipient: { contact_name: "Alice" } } as unknown as {
        order_id: string;
      },
    );
    const json = JSON.parse(
      capture.auditLines()[0].slice(AUDIT_PREFIX.length + 1).trimEnd(),
    );
    expect(json.argsRedacted.order_id).toBe("1");
    expect(json.argsRedacted.recipient).toBe("[REDACTED]");
  });
});
