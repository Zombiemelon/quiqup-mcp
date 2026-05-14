/**
 * Scorers for the create_fulfilment_order eval.
 *
 * Reuses toolNameMatch + argsOverlap from ./score-tool-call.ts unchanged, but
 * swaps in a fulfilment-specific `requiredFieldsPresent` because the top-level
 * required surface differs from last-mile:
 *
 *   - shipping_address (canonical fulfilment destination block)
 *   - items              (always required)
 *   - service_kind       (controls partner routing)
 *
 * Lenient by design (extras don't penalize; same philosophy as
 * ./score-tool-call.ts). Maintainers: keep this list aligned with whatever
 * the fulfilment endpoint's docs declare as required for POST
 * `/api/fulfilment/orders` — see references/endpoints.md.
 */

import type { Evaluator } from "@langfuse/client";

import { toolNameMatch, argsOverlap } from "./score-tool-call";

const REQUIRED_TOP_LEVEL = ["shipping_address", "items", "service_kind"] as const;

export const requiredFieldsPresent: Evaluator = async ({ output }) => {
  const args = (output as { args?: Record<string, unknown> } | undefined)?.args ?? {};
  const present = REQUIRED_TOP_LEVEL.filter((k) => k in args);
  return {
    name: "required-fields-present",
    value: present.length / REQUIRED_TOP_LEVEL.length,
    comment: `${present.length}/${REQUIRED_TOP_LEVEL.length}: [${present.join(", ")}]`,
  };
};

export const evaluators = [toolNameMatch, requiredFieldsPresent, argsOverlap];
