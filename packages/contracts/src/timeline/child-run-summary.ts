// Plan-013 T1.2 — `ChildRunSummary`, the summarized child-run projection a
// timeline row carries and `timeline.childRunExpand` expands.
//
// PROVENANCE. The canonical shape is
// `docs/architecture/contracts/api-payload-contracts.md` §"Plan-013 — Live
// Timeline Visibility And Reasoning Surfaces"; the behavior it serves is
// `Spec-013 §Timeline Entry Types` and `Spec-013 §Default Behavior`
// ("child-run activity defaults to summarized rows with explicit expansion").
// This module APPLIES both; it decides neither. Adding, removing, or renaming
// a member is a doc edit first.
//
// WHY THIS MODULE IS THE SUBDIRECTORY'S LEAF. `child-run-summary.ts` imports
// nothing from its siblings, `row.ts` imports it, `operations.ts` imports
// both, and `methods.ts` imports `operations.ts`. Every module in this package
// is an eager module-scope Zod initializer, so a back-import would throw
// `ReferenceError` at import time rather than fail to compile (the worked case
// is documented in the `repo.ts` header). The one-way chain is what keeps that
// unreachable.
//
// THE INCOMPLETENESS MARKER IS DELIBERATELY ABSENT. `Spec-013 §Fallback
// Behavior` says a child-run detail fetch that fails leaves "the summary row
// visible and marked incomplete rather than disappearing", and the Tier-8
// plan-readiness audit (§6 node NS-20) recorded that marker as UNSHAPED in the
// canonical contract doc — one of the residuals that restore explicitly did
// not clear, each requiring a lead-owned amendment. T1.2 therefore names
// exactly five members and this module ships exactly those five. Minting a
// marker here would be a wire member invented ahead of the amendment that
// decides its name, its type, and which side sets it.
import { z } from "zod";

import { NodeIdSchema, type NodeId } from "../node-id.js";
import { RunIdSchema, type RunId } from "../provider-driver.js";
import { RunStateSchema, type RunState } from "../runControl.js";

/**
 * The summarized child-run projection (`Spec-013 §Timeline Entry Types`).
 *
 * `producingNodeId` is optional because `Spec-013 §State And Data
 * Implications` requires provenance to "parent run and producing runtime
 * node" and a child run projected before its producing node is resolved has
 * no honest value to put there — an absent member says so, where a fabricated
 * one would not.
 */
export interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  producingNodeId?: NodeId | undefined;
  eventCount: number;
}

/**
 * Runtime validator for {@link ChildRunSummary}. `.strict()` — the member set
 * is closed, so a producer offering a sixth member (an incompleteness marker
 * among them) is refused here rather than silently stripped at the seam and
 * then missing from every consumer that expected it.
 */
export const ChildRunSummarySchema: z.ZodType<ChildRunSummary> = z
  .object({
    runId: RunIdSchema,
    parentRunId: RunIdSchema,
    state: RunStateSchema,
    producingNodeId: NodeIdSchema.optional(),
    // `.int()` is safe-integer in zod 4, which is the honest ceiling for a
    // tally: past it, distinct counts collapse onto one IEEE-754 double. No
    // separate cap constant — the counter form `runControl.ts` uses.
    eventCount: z.number().int().nonnegative(),
  })
  .strict();
