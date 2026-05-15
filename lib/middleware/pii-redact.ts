/**
 * PII redaction for audit-log arg capture.
 *
 * Why this module exists: M6 audit (lib/middleware/audit.ts) records every
 * tool invocation, including the arguments the LLM passed. Last-Mile order
 * args contain real recipient/sender personal data — names, phone numbers,
 * physical addresses — that we must NEVER persist into structured logs.
 * GDPR + the Quiqup data-handling policy treat aggregated Vercel runtime
 * logs as a downstream system; PII in there is a breach by default.
 *
 * Design stance: WHITELIST, not blacklist. A whitelist of keys that are
 * known-safe (ids, enums, payment_mode literals) is sound — anything else
 * gets `[REDACTED]`. Blacklisting (redact "name", "phone" etc.) is unsafe
 * because new schema fields land all the time and the redactor would
 * silently leak them. Conservative over-redaction is the explicit choice;
 * audit logs lose some debug context but never leak.
 *
 * Tool-family switch: the function takes the tool name so we can vary the
 * whitelist by tool family. Read-only tools (get_*, list_*, recent_*) take
 * essentially just ids and filters — the whitelist there is broad. Write
 * tools that touch Last-Mile order shapes (create_lastmile_order, update_*)
 * get the strict whitelist. Bulk-product / inbound tools sit in between.
 *
 * M7 hand-off: the audit pipeline (M7) may route to a real SIEM with
 * field-level access control. At that point a smarter redactor that emits
 * `{ field: <type>, redacted: true }` instead of bare `"[REDACTED]"`
 * markers becomes worthwhile, so downstream queries can filter on
 * "tools that received a phone-shaped value" without seeing the value.
 * Out of scope for M6.
 */

export const REDACTED = "[REDACTED]" as const;

/**
 * Keys safe to surface verbatim in audit logs, across ALL tools. These are
 * structural identifiers / enums / dimension descriptors with no PII
 * payload. Derived from existing tool input schemas under lib/tools/.
 *
 * Note: if you're tempted to add anything here that could carry a customer
 * value (e.g. `notes`, `description`, free-text `name`), DON'T. Add it to
 * a tool-family-specific list below instead, or just accept the redaction
 * and dig into the upstream API response if you need the value to debug.
 */
const GLOBAL_SAFE_KEYS = new Set<string>([
  // Identifiers (Quiqup-issued ids and merchant-supplied refs that are
  // technical strings, not customer-facing PII)
  "id",
  "order_id",
  "fulfilment_order_id",
  "inbound_id",
  "batch_id",
  "lastmile_order_id",
  "upload_id",
  "sku",
  "barcode",
  "partner_ref",
  "partner_order_id",
  "external_id",
  "request_id",
  "idempotency_key",

  // State / enum-shaped descriptors
  "state",
  "status",
  "kind",
  "service_kind",
  "payment_mode",
  "payment_type",
  "bucket",
  "reason_code",
  "source",

  // Pagination / filters
  "page",
  "per_page",
  "limit",
  "offset",
  "cursor",
  "filters",
  "from",
  "to",
  "since",
  "until",
  "filename", // CSV file *name* is fine; contents are redacted separately

  // Numeric quantities / dimensions (no PII risk on their own)
  "quantity",
  "delta",
  "weight",
  "length",
  "width",
  "height",
  "payment_amount",
  "capacity",

  // Cross-field structural keys (object roots whose children we still walk)
  "dimensions",
  "coordinates",
  "lat",
  "lng",
]);

/**
 * Keys that are explicitly PII-bearing and ALWAYS get redacted, regardless
 * of tool. Listed so the redactor short-circuits without traversing into
 * potentially-large nested objects.
 */
const ALWAYS_REDACT_KEYS = new Set<string>([
  "recipient",
  "sender",
  "origin",
  "destination",
  "contact_name",
  "contact_phone",
  "contact_email",
  "address",
  "address1",
  "address2",
  "town",
  "city",
  "country",
  "postal_code",
  "name",
  "phone",
  "email",
  "description",
  "notes",
  "metadata",
  "file_base64",
  // Auth-bearing fields — should never appear in args, but belt-and-braces
  "token",
  "bearer",
  "jwt",
  "api_key",
  "secret",
]);

/**
 * Special-case array keys: redact the array down to its length so we keep
 * the shape information for audit (e.g. "this call had 12 parcels") without
 * leaking per-item PII like parcel description / dimensions.
 */
const ARRAY_LENGTH_KEYS = new Set<string>([
  "items",
  "parcels",
  "products",
  "lines",
  "adjustments",
  "order_ids",
  "skus",
]);

/**
 * Tool-family classification. Drives which whitelist applies; see comment
 * at top of file. The classifier is intentionally simple (prefix match) —
 * a more elaborate one (per-tool registry) would be over-engineering at
 * M6 and would drift as new tools land.
 */
type ToolFamily = "lastmile-write" | "fulfilment-write" | "read";

function classifyTool(tool: string): ToolFamily {
  // Read-only tools: get_*, list_*, recent_*, whoami_*, claims_*.
  if (
    tool.startsWith("get_") ||
    tool.startsWith("list_") ||
    tool.startsWith("recent_") ||
    tool.startsWith("whoami") ||
    tool.startsWith("claims_")
  ) {
    return "read";
  }
  // Last-Mile write surface: order create/update/parcel/cancel/ready.
  if (
    tool.includes("lastmile") ||
    tool.includes("parcel") ||
    tool === "mark_ready_for_collection"
  ) {
    return "lastmile-write";
  }
  // Everything else (fulfilment/inbound/inventory/product/bulk) is
  // fulfilment-family write.
  return "fulfilment-write";
}

/**
 * Recursively walk args and produce a sanitised copy. Pure function — does
 * not mutate the input (audit log + handler must see the same object
 * identity is not assumed, but it'd still be a footgun).
 *
 * @param args raw tool args as passed to the handler
 * @param tool tool name for family-specific whitelist tuning
 */
export function redactArgs(args: unknown, tool: string): unknown {
  const family = classifyTool(tool);
  return walk(args, family, /* depth */ 0);
}

const MAX_DEPTH = 8; // defense against pathological nesting from a hostile/buggy caller

function walk(value: unknown, family: ToolFamily, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    // Strings at the leaf can be PII (a name, an address line). The caller
    // is responsible for putting strings under whitelisted keys; a bare
    // string at the root (which the MCP schema layer should reject anyway)
    // is treated as suspicious.
    return REDACTED;
  }

  if (Array.isArray(value)) {
    // Arrays-of-primitives at this level get summarised by length only.
    // Arrays-of-objects (e.g. an `items: [{name, quantity}]`) are walked
    // but the parent key drives whether we short-circuit (see object case).
    return value.map((v) => walk(v, family, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (ALWAYS_REDACT_KEYS.has(key)) {
        out[key] = REDACTED;
        continue;
      }
      if (ARRAY_LENGTH_KEYS.has(key) && Array.isArray(v)) {
        // Preserve cardinality info — useful for audit ("how many parcels
        // did this call cancel") without leaking per-item content.
        out[key] = { redacted: true, length: v.length };
        continue;
      }
      if (GLOBAL_SAFE_KEYS.has(key)) {
        // Whitelisted scalar/structural key. Still recurse so a nested
        // object under e.g. `filters` gets its OWN keys evaluated.
        if (v !== null && typeof v === "object") {
          out[key] = walk(v, family, depth + 1);
        } else {
          out[key] = v;
        }
        continue;
      }
      // Unknown key — conservative default differs by tool family:
      //   - read tools: unknown keys are usually filters/ids → keep
      //     scalars, redact strings (handled by walk recursion).
      //   - write tools: unknown keys default to redacted; new fields land
      //     all the time and we don't want a schema change to silently
      //     start leaking PII.
      if (family === "read") {
        if (v === null || typeof v !== "object") {
          // Scalar under a non-whitelisted key on a read tool. Numbers/
          // booleans are kept; strings are still redacted (could be a
          // search query, an email filter, etc.).
          out[key] = typeof v === "string" ? REDACTED : v;
        } else {
          out[key] = walk(v, family, depth + 1);
        }
      } else {
        out[key] = REDACTED;
      }
    }
    return out;
  }

  // Functions, symbols, bigints — never expected in JSON args.
  return REDACTED;
}
