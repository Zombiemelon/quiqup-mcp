import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

// Phase 2 of the two-phase bulk product upload, paired with
// bulk_validate_products. Run bulk_validate_products FIRST to surface
// per-row issues — commit only after the validate phase reports clean
// (or with acceptable errors).
//
// Scope model: NO scope-check helper call here. The exchanged Quiqup
// session JWT is itself the scope — platform-api routes the request to the
// caller's own product catalogue based on the JWT subject. There is no
// cross-tenant attack surface to gate at the MCP layer: the upstream
// rejects writes against another merchant's products by virtue of the JWT
// being merchant-scoped. The other M6 guardrails (rate-limit, idempotency,
// audit) still apply because the blast radius within the caller's own
// catalogue is potentially large.
//
// Idempotency TTL is 30 minutes (vs the M6 default 15) because a bulk
// commit can be slow to process upstream and clients legitimately retry
// after long backoff windows; 30m makes "same key, same body" replays
// safe across realistic retry curves.
//
// Rate limit is the tightest in the M6 surface (2 commits / 60s): each
// call mutates many rows at once, and the operator-facing recovery cost
// of a runaway loop is correspondingly higher.
//
// Input shape: base64 CSV body for symmetry with bulk_validate_products
// (the MCP transport has no native file upload primitive). filename is
// retained as a hint for the upstream; idempotency_key is the M6 replay
// guard.

const inputSchema = z.object({
  // CSV uploaded as base64 — matches bulk_validate_products shape.
  file_base64: z.string().min(1, "file_base64 is required"),
  filename: z.string().min(1, "filename is required"),
  // Optional but strongly recommended: the M6 wrapper de-duplicates same-key
  // calls inside the TTL window so an LLM retry storm can't double-commit.
  idempotency_key: z.string().optional(),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "bulk_commit_products",
  description:
    "Phase 2 of the two-phase bulk product upload: commits a base64-encoded " +
    "CSV of product rows to the caller's Quiqup Fulfilment catalogue on " +
    "platform-api.quiqup.com. ALWAYS run bulk_validate_products first to " +
    "surface per-row issues before committing — this tool mutates the " +
    "product catalogue and is rate-limited to 2 calls/minute. Supply " +
    "idempotency_key to make retries safe (30 minute window). Per-row " +
    "errors returned by the upstream are surfaced in the response text " +
    "without failing the overall call; a 4xx/5xx rejection of the whole " +
    "batch is bubbled as an error.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 2, refillPerSec: 2 / 60 }, // 2 bulk commits/min — tightest
    idempotency: { keyArg: "idempotency_key", ttlMs: 30 * 60 * 1000 }, // longer TTL — bulk runs are slow
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("bulk_commit_products requires an authenticated user");
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupFulfilmentClient({ jwt });
    const data = (await client.request(
      "POST",
      "/api/fulfilment/products/bulk_commit",
      { body: { file_base64: args.file_base64, filename: args.filename } },
    )) as { committed?: number; errors?: unknown[] } | null;

    const committed =
      data && typeof data === "object" && typeof data.committed === "number"
        ? data.committed
        : undefined;
    const errors =
      data && typeof data === "object" && Array.isArray(data.errors)
        ? data.errors
        : [];

    const summary =
      committed !== undefined
        ? `Bulk commit accepted: ${committed} row(s) committed.`
        : "Bulk commit accepted.";
    const errorBlock =
      errors.length > 0
        ? `\n\n${errors.length} per-row error(s):\n${JSON.stringify(errors, null, 2)}`
        : "";
    const payload = `${summary}${errorBlock}\n\nFull upstream response:\n${JSON.stringify(
      data,
      null,
      2,
    )}`;

    return {
      content: [{ type: "text" as const, text: payload }],
    };
  },
};
