import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { auth } from "@clerk/nextjs/server";
import { registerClaimsDump } from "@/lib/tools/claims-dump";
import { registerRecentOrders } from "@/lib/tools/recent-orders";
import { registerTool } from "@/lib/tools/register";

// M2 — fully tested, mocked, error-mapped.
import { spec as getLastmileOrderSpec } from "@/lib/tools/get-lastmile-order";

// Diagnostic — confirms the exchanged session-JWT resolves on platform-api.
import { spec as whoamiPlatformSpec } from "@/lib/tools/whoami-platform";

// M3 thin pass-through reads (Last-Mile + Fulfilment).
// TODO(M4): cassette + output schemas + error mapping for these.
import { spec as getLastmileOrderLabelSpec } from "@/lib/tools/get-lastmile-order-label";
import { spec as getFulfilmentOrderSpec } from "@/lib/tools/get-fulfilment-order";
import { spec as listInventorySpec } from "@/lib/tools/list-inventory";
import { spec as getInventoryBySkuSpec } from "@/lib/tools/get-inventory-by-sku";
import { spec as listSkuBatchesSpec } from "@/lib/tools/list-sku-batches";
import { spec as getBatchSpec } from "@/lib/tools/get-batch";
import { spec as listInboundSlotsSpec } from "@/lib/tools/list-inbound-slots";
import { spec as listInboundsSpec } from "@/lib/tools/list-inbounds";
import { spec as getInboundSpec } from "@/lib/tools/get-inbound";
import { spec as getInboundStateHistorySpec } from "@/lib/tools/get-inbound-state-history";
import { spec as getInboundItemsSpec } from "@/lib/tools/get-inbound-items";
import { spec as getProductBySkuSpec } from "@/lib/tools/get-product-by-sku";

// M3 thin pass-through enabled writes.
// TODO(M4): cassette + output schemas + error mapping for these.
// TODO(M6): retroactive scope/audit/idempotency guardrails.
import { spec as createLastmileOrderSpec } from "@/lib/tools/create-lastmile-order";
import { spec as updateLastmileOrderSpec } from "@/lib/tools/update-lastmile-order";
import { spec as addParcelToOrderSpec } from "@/lib/tools/add-parcel-to-order";
import { spec as createFulfilmentOrderSpec } from "@/lib/tools/create-fulfilment-order";
import { spec as updateFulfilmentOrderSpec } from "@/lib/tools/update-fulfilment-order";
import { spec as createProductSpec } from "@/lib/tools/create-product";
import { spec as updateProductSpec } from "@/lib/tools/update-product";

// Disabled-pending-M6: registered for surface coverage; handler throws.
// Flip on at M6 with scope + audit + idempotency in place.
import { spec as markReadyForCollectionSpec } from "@/lib/tools/mark-ready-for-collection";
import { spec as cancelLastmileOrdersBatchSpec } from "@/lib/tools/cancel-lastmile-orders-batch";
import { spec as removeParcelFromOrderSpec } from "@/lib/tools/remove-parcel-from-order";
import { spec as adjustStockSpec } from "@/lib/tools/adjust-stock";
import { spec as bookInboundSlotSpec } from "@/lib/tools/book-inbound-slot";
import { spec as bulkValidateProductsSpec } from "@/lib/tools/bulk-validate-products";
import { spec as bulkCommitProductsSpec } from "@/lib/tools/bulk-commit-products";

// Staging-only state-machine helpers (Postman: Quiqup Staging State Change).
// Each pins `environment: z.literal("staging")` at the input schema, so any
// non-staging call is rejected by the validator before the handler runs.
import { spec as setOutForDeliveryBatchSpec } from "@/lib/tools/set-out-for-delivery-batch";
import { spec as setCollectionFailedBatchSpec } from "@/lib/tools/set-collection-failed-batch";
import { spec as setDeliveryFailedBatchSpec } from "@/lib/tools/set-delivery-failed-batch";

const handler = createMcpHandler(
  (server) => {
    // -- Legacy tools (own register*() functions per M1 audit) --
    registerClaimsDump(server);
    registerRecentOrders(server);

    // -- M2: hardened (cassette, output schema, error mapping) --
    registerTool(server, getLastmileOrderSpec);

    // -- Diagnostic for auth-vs-payload triage on platform-api --
    registerTool(server, whoamiPlatformSpec);

    // -- M3 reads: thin pass-through (TODO(M4) hardening) --
    registerTool(server, getLastmileOrderLabelSpec);
    registerTool(server, getFulfilmentOrderSpec);
    registerTool(server, listInventorySpec);
    registerTool(server, getInventoryBySkuSpec);
    registerTool(server, listSkuBatchesSpec);
    registerTool(server, getBatchSpec);
    registerTool(server, listInboundSlotsSpec);
    registerTool(server, listInboundsSpec);
    registerTool(server, getInboundSpec);
    registerTool(server, getInboundStateHistorySpec);
    registerTool(server, getInboundItemsSpec);
    registerTool(server, getProductBySkuSpec);

    // -- M3 enabled writes: thin pass-through (TODO(M4)/M6 hardening) --
    registerTool(server, createLastmileOrderSpec);
    registerTool(server, updateLastmileOrderSpec);
    registerTool(server, addParcelToOrderSpec);
    registerTool(server, createFulfilmentOrderSpec);
    registerTool(server, updateFulfilmentOrderSpec);
    registerTool(server, createProductSpec);
    registerTool(server, updateProductSpec);

    // -- Disabled pending M6 (scope/audit/idempotency) --
    registerTool(server, markReadyForCollectionSpec);
    registerTool(server, cancelLastmileOrdersBatchSpec);
    registerTool(server, removeParcelFromOrderSpec);
    registerTool(server, adjustStockSpec);
    registerTool(server, bookInboundSlotSpec);
    registerTool(server, bulkValidateProductsSpec);
    registerTool(server, bulkCommitProductsSpec);

    // -- Staging-only state-machine helpers (env pinned in the schema) --
    registerTool(server, setOutForDeliveryBatchSpec);
    registerTool(server, setCollectionFailedBatchSpec);
    registerTool(server, setDeliveryFailedBatchSpec);
  },
  {},
  { basePath: "" },
);

const authHandler = withMcpAuth(
  handler,
  async (_req, bearerToken) => {
    if (!bearerToken) return undefined;

    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    if (!clerkAuth?.subject) return undefined;

    return {
      token: bearerToken,
      clientId: clerkAuth.clientId ?? "",
      scopes: clerkAuth.scopes ?? [],
      extra: { clerkAuth },
    };
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
  },
);

export { authHandler as GET, authHandler as POST };
