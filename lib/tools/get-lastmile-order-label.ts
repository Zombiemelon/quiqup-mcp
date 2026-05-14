import { z } from "zod";
import type { ToolSpec } from "./register";
import { signLabelUrl, getAppBaseUrl } from "@/lib/signed-url";

// 2026-05-14 (v2) — switched from inline base64 PDF (returned as a
// `resource`+`blob` content block) to a signed download URL. claude.ai web
// does not render `application/pdf` resource blocks; the bytes were
// silently dropped from the transcript and users had no way to actually
// obtain the label. The tool now mints a short-lived HMAC-signed URL
// against the caller's Clerk userId, and the matching route
// (`app/api/label/[order_id]/route.ts`) performs the same-IdP exchange
// and proxies the PDF when the user clicks the link. Bytes never enter
// the LLM transport, the URL is renderable in every host, and the
// upstream PDF lives behind expiry + signature.
//
// PII note: the PDF body still contains customer name + address on the
// AWB. Audit-log redaction at M6 stays in scope — the redaction target
// just moves from the tool result to the download-route access log.
const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
});

const outputSchema = z
  .object({
    url: z.string().url(),
    exp: z.number(),
  })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_lastmile_order_label",
  description:
    "Get a short-lived (~10 minute) download URL for the AWB (airway bill) " +
    "label PDF of a Quiqup Last-Mile order. Returns a text block containing " +
    "a clickable markdown link plus an MCP `resource_link` block with the " +
    "same URL. Hand the URL to the user verbatim — do NOT fetch the PDF " +
    "yourself or attempt to embed it. The PDF contains the customer name " +
    "and shipping address as printed on the label.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId)
      throw new Error("get_lastmile_order_label requires an authenticated user");

    const { url, exp } = signLabelUrl({
      orderId: args.order_id,
      userId: auth.userId,
      baseUrl: getAppBaseUrl(),
    });

    const expiresAt = new Date(exp * 1000).toISOString();
    const summary =
      `AWB label download URL for order_id=${args.order_id} ` +
      `(expires ${expiresAt}, ~10 minutes from now). ` +
      `Open in a browser to download the PDF: ${url}`;

    return {
      content: [
        { type: "text" as const, text: summary },
        {
          type: "resource_link" as const,
          uri: url,
          name: `awb_${args.order_id}.pdf`,
          mimeType: "application/pdf",
          description: `AWB label PDF for Quiqup order ${args.order_id} (expires ${expiresAt})`,
        },
      ],
    };
  },
};
