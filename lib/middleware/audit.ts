/**
 * Structured audit log for tool invocations.
 *
 * Why this module exists: M6 requires a tamper-evident-ish record of every
 * write-tool call so we can answer questions like "did userId X cancel
 * order Y on date Z" without trawling the Quiqup backend. Vercel persists
 * stdout from serverless functions into its runtime log surface, which the
 * platform team can route into Datadog / a long-term store. So a JSON line
 * on stdout, with a stable prefix grep-able from log aggregation, is the
 * cheapest viable audit transport for M6.
 *
 * The `audit:` prefix is the contract: log aggregation pipelines (and
 * grep-based incident response) match on the prefix and parse the rest as
 * JSON. Do NOT change the prefix without updating downstream consumers —
 * notably the platform-ops runbook (search "audit:" in the runbook repo).
 *
 * M7 hand-off: ship to a real append-only audit store (Datadog audit logs,
 * or an S3 bucket with object-lock). Until then, stdout-on-Vercel is
 * "good enough for breach-investigation-but-not-compliance-attestation".
 * Document this clearly in the M7 spec ticket.
 */

import { redactArgs } from "./pii-redact";

/**
 * Canonical audit record. Fields are intentionally flat (no nesting) so
 * log-search tools can filter on `tool`, `userId`, `ok` etc. without
 * needing JSON-path expressions.
 */
export interface AuditRecord {
  /** ISO-8601 timestamp captured at emit time. Server clock; UTC. */
  ts: string;
  /** Clerk userId of the inbound caller, or null for unauth. */
  userId: string | null;
  /** Clerk orgId if the inbound caller had an org claim. */
  orgId: string | null;
  /** Tool name, e.g. "mark_ready_for_collection". */
  tool: string;
  /** Idempotency key if the call supplied one. */
  idempotencyKey?: string;
  /** Wall-clock duration of the handler in ms. */
  durationMs: number;
  /** Whether the handler returned cleanly (true) or threw (false). */
  ok: boolean;
  /** Short error string if !ok. NEVER include stack traces (may leak code paths). */
  error?: string;
  /** Args after pii-redact processing — see lib/middleware/pii-redact.ts. */
  argsRedacted: unknown;
}

/** Stable prefix; log-aggregation pipelines match on this verbatim. */
export const AUDIT_PREFIX = "audit:";

/**
 * Emit one audit record. Writes a single line to stdout: `audit: <json>\n`.
 *
 * Failure mode: stringify errors (e.g. a circular ref slipping past
 * redaction) are caught and logged as a fallback record so the audit
 * line still appears in logs — never silently drop an audit record.
 */
export function auditLog(record: AuditRecord): void {
  let line: string;
  try {
    line = `${AUDIT_PREFIX} ${JSON.stringify(record)}`;
  } catch (err) {
    // Fallback: emit a minimal record + the stringify error. The wrapper
    // should never produce a circular structure (redactArgs builds fresh
    // objects), but defending against this is cheap.
    line = `${AUDIT_PREFIX} ${JSON.stringify({
      ts: record.ts,
      userId: record.userId,
      orgId: record.orgId,
      tool: record.tool,
      ok: false,
      error: `audit-stringify-failed: ${(err as Error).message}`,
      argsRedacted: "[UNSERIALIZABLE]",
      durationMs: record.durationMs,
    })}`;
  }
  // Use process.stdout.write directly — console.log adds source-map noise
  // in some Next.js dev configurations and could split the line.
  process.stdout.write(`${line}\n`);
}

/**
 * Convenience helper used by the registerTool wrapper. Builds and emits a
 * record from the per-call context. Kept thin so the wrapper code reads
 * cleanly.
 */
export function emitAuditRecord(params: {
  userId: string | null;
  orgId: string | null;
  tool: string;
  args: unknown;
  idempotencyKey?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}): void {
  auditLog({
    ts: new Date().toISOString(),
    userId: params.userId,
    orgId: params.orgId,
    tool: params.tool,
    idempotencyKey: params.idempotencyKey,
    durationMs: params.durationMs,
    ok: params.ok,
    error: params.error,
    argsRedacted: redactArgs(params.args, params.tool),
  });
}
