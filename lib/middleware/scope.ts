/**
 * Per-resource ownership assertion helpers.
 *
 * Why this module exists: M6 needs SOMETHING to prevent userId X from
 * calling `mark_ready_for_collection({ order_id: <Y's order> })`. Without
 * this, a hostile or buggy client could exfiltrate / mutate other
 * merchants' resources through our MCP layer, because Quiqup's gateway
 * trusts the session JWT we forward.
 *
 * Why this module is shaped as helpers (not middleware): the seven
 * disabled write tools each have different scope shapes. `adjust_stock`
 * scopes on SKU; `mark_ready_for_collection` scopes on order_id;
 * `book_inbound_slot` scopes on inbound_id; bulk tools take an upload_id
 * that maps to a tenant only after the validate phase. A single
 * wrapper-level "scope guard" would either be over-fitted to one shape or
 * over-engineered for all of them. So we expose simple helpers each tool
 * calls *inside* its handler — explicit, greppable, easy to test.
 *
 * Trust model (M6 reality): Quiqup's API gateway already gates by the
 * session JWT we send — calling `getOrder('orderY')` with userId X's JWT
 * returns 404 (or 403, depending on the endpoint) because Quiqup's
 * resolver doesn't see the order in X's scope. So in practice these
 * helpers double-confirm something the upstream already enforces.
 *
 * Why double-confirm: it surfaces the violation as a SCOPE error in our
 * audit log (vs. a generic upstream 404), and it short-circuits BEFORE
 * the dangerous side-effect call. Without this, `mark_ready_for_collection`
 * would try to PUT against a non-owned order, get a 404, and the audit log
 * would record "tried to ready_for_collection foreign order" — useful, but
 * the PUT already left an attempt trace upstream. The helper pre-empts.
 *
 * M7 lift: an org-scoped index that maps {orderId → orgId} (or similar
 * per-resource → tenant) directly, so we don't need a full GET round-trip
 * to verify scope. Right now we pay one extra upstream GET per write call.
 * Acceptable at M6 traffic; quantified in M7 perf budget.
 */

import { QuiqupHttpError, QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

/**
 * Thrown by the assert* helpers when a resource is not visible under the
 * caller's session JWT. Carries the resource type + id so handlers and
 * audit logs can render a clear message.
 */
export class ScopeViolationError extends Error {
  constructor(
    public readonly resource: string,
    public readonly resourceId: string,
    public readonly userId: string,
  ) {
    super(
      `Scope violation: userId=${userId} cannot access ${resource}=${resourceId}. ` +
        `Upstream returned 404 under this user's session — the resource either ` +
        `doesn't exist or belongs to a different tenant.`,
    );
    this.name = "ScopeViolationError";
  }
}

/**
 * Confirm that `orderId` is visible under `userId`'s Quiqup session JWT
 * (i.e. is owned by this user's merchant). Throws ScopeViolationError on
 * 404, propagates other QuiqupHttpErrors (5xx etc.) unchanged.
 *
 * Wave 2 callers: invoke this at the TOP of the handler, before any
 * mutating call. Pattern:
 *   await assertOrderBelongsToUser(args.order_id, auth.userId!);
 *   // ... rest of handler ...
 */
export async function assertOrderBelongsToUser(
  orderId: string,
  userId: string,
): Promise<void> {
  if (!userId) {
    // Shouldn't happen — registerTool only invokes handlers with an auth
    // context, and write tools should reject null userId upstream of this.
    // But: fail closed if it does.
    throw new Error(
      "assertOrderBelongsToUser called without a userId — guard your handler with `if (!auth.userId) throw ...` before invoking scope helpers.",
    );
  }
  const jwt = await getQuiqupReadyJwt(userId);
  const client = new QuiqupLastmileClient({ jwt });
  try {
    await client.getOrder(orderId);
  } catch (err) {
    if (err instanceof QuiqupHttpError && err.status === 404) {
      throw new ScopeViolationError("order", orderId, userId);
    }
    throw err;
  }
}

/**
 * Confirm that `sku` is visible under `userId`'s Quiqup session JWT.
 * Same contract as assertOrderBelongsToUser. Uses the Fulfilment
 * client because SKUs live on platform-api, not api-ae.
 */
export async function assertSkuBelongsToUser(
  sku: string,
  userId: string,
): Promise<void> {
  if (!userId) {
    throw new Error(
      "assertSkuBelongsToUser called without a userId — guard your handler with `if (!auth.userId) throw ...` before invoking scope helpers.",
    );
  }
  const jwt = await getQuiqupReadyJwt(userId);
  const client = new QuiqupFulfilmentClient({ jwt });
  try {
    await client.request(
      "GET",
      `/api/fulfilment/products/${encodeURIComponent(sku)}`,
    );
  } catch (err) {
    if (err instanceof QuiqupHttpError && err.status === 404) {
      throw new ScopeViolationError("sku", sku, userId);
    }
    throw err;
  }
}
