import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { auditLog, emitAuditRecord, AUDIT_PREFIX } from "@/lib/middleware/audit";

// Capture stdout for assertion. We spy on process.stdout.write rather than
// console.log because audit.ts uses .write directly to avoid Next.js
// dev-mode source-map noise splitting the line.
function captureStdout() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

describe("auditLog", () => {
  let capture: ReturnType<typeof captureStdout>;
  beforeEach(() => {
    capture = captureStdout();
  });
  afterEach(() => capture.restore());

  it("emits a single line prefixed with `audit: ` followed by valid JSON", () => {
    auditLog({
      ts: "2026-05-14T12:00:00.000Z",
      userId: "user_abc",
      orgId: null,
      tool: "mark_ready_for_collection",
      durationMs: 42,
      ok: true,
      argsRedacted: { order_id: "ord_1" },
    });
    expect(capture.lines).toHaveLength(1);
    const line = capture.lines[0];
    expect(line.endsWith("\n")).toBe(true);
    expect(line.startsWith(`${AUDIT_PREFIX} `)).toBe(true);

    const json = JSON.parse(line.slice(AUDIT_PREFIX.length + 1).trimEnd());
    expect(json.tool).toBe("mark_ready_for_collection");
    expect(json.ok).toBe(true);
    expect(json.durationMs).toBe(42);
    expect(json.argsRedacted).toEqual({ order_id: "ord_1" });
  });

  it("falls back to a minimal record when stringify fails", () => {
    // Build a circular structure to defeat JSON.stringify.
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    auditLog({
      ts: "2026-05-14T12:00:00.000Z",
      userId: "user_abc",
      orgId: null,
      tool: "x",
      durationMs: 1,
      ok: false,
      argsRedacted: cyclic,
    });
    expect(capture.lines).toHaveLength(1);
    const json = JSON.parse(
      capture.lines[0].slice(AUDIT_PREFIX.length + 1).trimEnd(),
    );
    expect(json.error).toMatch(/audit-stringify-failed/);
    expect(json.ok).toBe(false);
  });
});

describe("emitAuditRecord", () => {
  let capture: ReturnType<typeof captureStdout>;
  beforeEach(() => {
    capture = captureStdout();
  });
  afterEach(() => capture.restore());

  it("redacts args through pii-redact before emitting", () => {
    emitAuditRecord({
      userId: "user_abc",
      orgId: "org_1",
      tool: "create_lastmile_order",
      args: {
        kind: "partner_same_day",
        origin: { contact_name: "Alice", contact_phone: "+9715" },
        destination: { contact_name: "Bob", contact_phone: "+9716" },
      },
      durationMs: 100,
      ok: true,
    });
    const line = capture.lines[0];
    const json = JSON.parse(line.slice(AUDIT_PREFIX.length + 1).trimEnd());
    // PII keys are redacted; structural keys preserved.
    expect(json.argsRedacted.kind).toBe("partner_same_day");
    expect(json.argsRedacted.origin).toBe("[REDACTED]");
    expect(json.argsRedacted.destination).toBe("[REDACTED]");
    // ISO timestamp shape.
    expect(json.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
