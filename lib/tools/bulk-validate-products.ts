import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

// M6: enabled. Validation-only — the upstream endpoint does NOT persist
// products; on success it returns an `upload_id` you then pass to
// `bulk_commit_products` (phase 2). Because the call is naturally idempotent
// — re-validating the same CSV is harmless — we don't wire an idempotency
// key here; the M6 guardrails on this tool are just audit + rate-limit.
const inputSchema = z.object({
  // CSV uploaded as base64 — the MCP transport doesn't have a native file
  // upload primitive, so the canonical shape is base64 + filename. The
  // upstream accepts JSON with these two fields (the CLI cheatsheet shows
  // multipart, but the JSON path is what platform-api exposes to API clients).
  file_base64: z.string().min(1, "file_base64 is required"),
  filename: z.string().min(1, "filename is required"),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "bulk_validate_products",
  description:
    "Phase 1 of the two-phase bulk product upload on platform-api.quiqup.com: " +
    "validates a base64-encoded CSV against the merchant's catalog and returns " +
    "an upload_id (plus any row-level errors). On a passing validation, the " +
    "natural next step is to call `bulk_commit_products` with the returned " +
    "upload_id to persist the rows.",
  inputSchema,
  outputSchema,
  guardrails: {
    // 20/min — generous, since the call is read-only validation with no
    // upstream side-effects. Capacity matches the sustained refill so the
    // limit is a soft ceiling rather than a burst cap.
    rateLimit: { capacity: 20, refillPerSec: 20 / 60 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId)
      throw new Error("bulk_validate_products requires an authenticated user");
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupFulfilmentClient({ jwt });
    const data = await client.request(
      "POST",
      "/api/fulfilment/products/bulk/validate",
      { body: { file_base64: args.file_base64, filename: args.filename } },
    );

    // Summarise the upstream response. The shape we expect is documented in
    // docs/quiqup-api/references/endpoints.md (phase 1):
    //   { upload_id: string, row_count?: number, errors?: Array<{row: number, ...}> }
    // We surface ALL of it as a pretty-printed JSON block plus a one-line
    // header so the LLM can see "passed with N rows" or "failed with K
    // errors" without parsing JSON. A response that contains `errors[]` is
    // STILL a successful tool call — validation that finds problems is the
    // happy path, not an error — so we never set isError here.
    const body = (data ?? {}) as {
      upload_id?: string;
      row_count?: number;
      errors?: unknown[];
    };
    const errorCount = Array.isArray(body.errors) ? body.errors.length : 0;
    const header =
      errorCount > 0
        ? `Validation completed with ${errorCount} row error(s). Review and re-upload before calling bulk_commit_products.`
        : `Validation passed${
            body.row_count !== undefined ? ` (${body.row_count} rows)` : ""
          }${
            body.upload_id
              ? `. Pass upload_id="${body.upload_id}" to bulk_commit_products to persist.`
              : "."
          }`;

    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\n\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
