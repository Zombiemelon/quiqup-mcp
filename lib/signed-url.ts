/**
 * HMAC-signed download URLs for the AWB-label route.
 *
 * Why this exists: the MCP `get_lastmile_order_label` tool used to return the
 * PDF inline as a `resource`+`blob` content item. claude.ai web does not
 * render `application/pdf` resources, so the bytes were dropped from the
 * transcript and the user had no way to obtain the label. Returning a URL
 * the user can click sidesteps the host's rendering gap, but the URL must
 * carry its own auth — the user clicking the link from a chat UI has no
 * Clerk session against THIS app.
 *
 * Trust model: the URL embeds the Clerk userId of the inbound MCP caller,
 * the orderId being labelled, and an absolute expiry. An HMAC-SHA256 over
 * those three fields (plus a server-side secret) gates the route — the
 * route does NOT trust the userId until the signature verifies. Once
 * verified, the route uses the userId to mint a Quiqup-ready JWT via the
 * existing same-IdP exchange (`getQuiqupReadyJwt`) and fetches the PDF on
 * the user's behalf, no different from how the tool handler used to.
 *
 * Secret rotation: changing `LABEL_URL_SIGNING_SECRET` invalidates all
 * outstanding signed URLs immediately. That's the intended behaviour — TTL
 * is the recovery path for the common case, secret rotation for breach.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SECONDS = 10 * 60;

function getSecret(): string {
  const secret = process.env.LABEL_URL_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "LABEL_URL_SIGNING_SECRET is missing or too short (need ≥32 chars). " +
        "Generate one with `openssl rand -hex 32` and set it in env.",
    );
  }
  return secret;
}

function payload(orderId: string, userId: string, exp: number): string {
  return `${userId}.${orderId}.${exp}`;
}

function hmac(orderId: string, userId: string, exp: number): string {
  return createHmac("sha256", getSecret())
    .update(payload(orderId, userId, exp))
    .digest("base64url");
}

export interface SignLabelUrlInput {
  orderId: string;
  userId: string;
  baseUrl: string;
  ttlSeconds?: number;
  now?: () => number;
}

export function signLabelUrl({
  orderId,
  userId,
  baseUrl,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now,
}: SignLabelUrlInput): { url: string; exp: number } {
  const exp = Math.floor(now() / 1000) + ttlSeconds;
  const sig = hmac(orderId, userId, exp);
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const url = new URL(
    `${trimmedBase}/api/label/${encodeURIComponent(orderId)}`,
  );
  url.searchParams.set("u", userId);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return { url: url.toString(), exp };
}

export type VerifyResult =
  | { ok: true; userId: string; orderId: string; exp: number }
  | { ok: false; reason: "expired" | "bad_signature" | "missing_params" };

export interface VerifyLabelUrlInput {
  orderId: string;
  userId: string | null;
  exp: string | null;
  sig: string | null;
  now?: () => number;
}

export function verifyLabelUrl({
  orderId,
  userId,
  exp,
  sig,
  now = Date.now,
}: VerifyLabelUrlInput): VerifyResult {
  if (!userId || !exp || !sig) return { ok: false, reason: "missing_params" };
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= 0)
    return { ok: false, reason: "missing_params" };
  if (expNum * 1000 < now()) return { ok: false, reason: "expired" };

  const expected = hmac(orderId, userId, expNum);
  // Compare BYTE lengths, not character lengths: a crafted non-ASCII `sig`
  // can have the same string length but a different UTF-8 byte length, and
  // timingSafeEqual throws on length mismatch — which would surface as a
  // 500 from a public route instead of a clean `bad_signature`.
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  return { ok: true, userId, orderId, exp: expNum };
}

export function getAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}
