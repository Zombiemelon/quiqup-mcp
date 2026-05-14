/**
 * Scorers for the recent_orders eval.
 *
 * Reuses toolNameMatch + argsOverlap from ./score-tool-call.ts unchanged, but
 * swaps in a recent_orders-specific `requiredFieldsPresent` because the only
 * fields a competent caller MUST surface are:
 *
 *   - state  (the lifecycle bucket — pending / delivered / failed / etc.)
 *   - limit  (response size cap; default 5, but every realistic ask names one)
 *
 * `from` / `to` are intentionally NOT in this required list — they're
 * date-range hints with sensible 7-day-window defaults, and many merchant
 * questions ("what's pending right now?") legitimately omit them. argsOverlap
 * still rewards getting them right when they ARE specified.
 *
 * Lenient by design — extras don't penalize. Same philosophy as
 * ./score-tool-call.ts.
 */

import type { Evaluator } from "@langfuse/client";

import { toolNameMatch, argsOverlap } from "./score-tool-call";

const REQUIRED_TOP_LEVEL = ["state", "limit"] as const;

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
