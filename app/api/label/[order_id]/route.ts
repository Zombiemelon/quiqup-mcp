/**
 * Public download endpoint for AWB-label PDFs.
 *
 * Auth model: NO Clerk session cookie or bearer token. The route is
 * gated entirely by an HMAC signature in the query string (see
 * `lib/signed-url.ts`). The `get_lastmile_order_label` MCP tool mints
 * these URLs against the authenticated caller's Clerk userId; the route
 * trusts the userId only after the signature verifies, then re-uses the
 * standard `getQuiqupReadyJwt(userId)` path to fetch the PDF upstream —
 * exact same trust path the inline tool handler used to take, just
 * deferred until the user clicks the link.
 *
 * Why a download URL at all: claude.ai web does not render
 * `application/pdf` content blocks inline, so the prior tool result
 * (text + base64 `blob` resource) silently dropped the PDF on its way
 * to the user. A signed URL bypasses the host's rendering gap.
 */
import { NextResponse } from "next/server";
import { getQuiqupReadyJwt } from "@/lib/quiqup";
import {
  QuiqupLastmileClient,
  QuiqupHttpError,
} from "@/lib/clients/quiqup-lastmile";
import { verifyLabelUrl } from "@/lib/signed-url";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ order_id: string }> },
) {
  const { order_id: orderId } = await params;
  const url = new URL(request.url);
  const verdict = verifyLabelUrl({
    orderId,
    userId: url.searchParams.get("u"),
    exp: url.searchParams.get("exp"),
    sig: url.searchParams.get("sig"),
  });

  if (!verdict.ok) {
    const status = verdict.reason === "expired" ? 410 : 403;
    return NextResponse.json(
      { error: verdict.reason },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  let jwt: string;
  try {
    jwt = await getQuiqupReadyJwt(verdict.userId);
  } catch (err) {
    return NextResponse.json(
      { error: "session_unavailable", detail: (err as Error).message },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const client = new QuiqupLastmileClient({ jwt });
  let data: { contentType?: string; base64?: string } | null;
  try {
    data = (await client.request(
      "GET",
      `/order_label/${encodeURIComponent(orderId)}`,
    )) as { contentType?: string; base64?: string } | null;
  } catch (err) {
    if (err instanceof QuiqupHttpError) {
      return NextResponse.json(
        { error: "upstream", status: err.status, body: err.body },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    throw err;
  }

  if (!data?.base64) {
    return NextResponse.json(
      { error: "empty_body" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawContentType = data.contentType?.split(";")[0]?.trim() ?? "";
  if (rawContentType && !rawContentType.startsWith("application/pdf")) {
    return NextResponse.json(
      { error: "unexpected_content_type", contentType: rawContentType },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const bytes = Buffer.from(data.base64, "base64");
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="awb_${orderId}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
