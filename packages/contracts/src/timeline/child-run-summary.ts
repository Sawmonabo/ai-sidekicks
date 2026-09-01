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
// THE INCOMPLETENESS MARKER. `Spec-013 §Fallback Behavior` says a child-run
// detail fetch that fails leaves "the summary row visible and marked
// incomplete rather than disappearing". The Tier-8 plan-readiness audit (§6
// node NS-20) recorded that marker as unshaped in the canonical contract doc;
// it is shaped here and in that doc together.
//
// WHY A DISCRIMINATED MEMBER AND NOT A BOOLEAN. A bare `incomplete: true` says
// that something is missing without saying what, which leaves a consumer no
// basis to decide between retrying, waiting, and giving up — and those are the
// three different right answers for the three causes below. The member is also
// REQUIRED rather than optional: an absent marker would be a third state
// meaning "probably fine", and the spec's rule is that incompleteness is
// STATED. Before this member the only signal was a low `eventCount`, which is
// indistinguishable from a child run that genuinely did little.
//
// THE CAUSE SET IS CLOSED AND BORROWED, NOT INVENTED. Each member is a term
// the corpus already owns, so this surface adds no vocabulary:
//   * `detail_fetch_failed` — `Spec-013 §Fallback Behavior`'s own naming of
//     the condition ("if a child-run detail fetch fails"). Transient.
//   * `pending_backfill` — `Spec-008 §Required Behavior`'s coverage-state
//     term, reused verbatim. It is the same condition at a narrower scope: one
//     child run's rows rather than the session's whole history. That section
//     defines its outstanding-source arm as transient, clearing when the peer
//     serves.
//   * `compacted` — already the shipped vocabulary on this subdirectory's own
//     `ReasoningSurfaceReadResponse` availability arm and on
//     `HydratedContentUnavailableReason`. Terminal; no retry recovers it.
// Deliberately NOT reused: `session.history_backfill_unavailable` (a
// response-level error code, which `Spec-008 §Required Behavior` rules out by
// name — the joiner's coverage state "is `pending_backfill`, never this
// code"), `NodeState`'s `offline` (a node lifecycle state, the INPUT to
// `pending_backfill` rather than a synonym), and `RepoMountHealth`'s
// `unreachable` (scoped to filesystem mounts, and its own module warns against
// overloading that word across axes).
import { z } from "zod";

import { NodeIdSchema, type NodeId } from "../node-id.js";
import { RunIdSchema, type RunId } from "../provider-driver.js";
import { RunStateSchema, type RunState } from "../runControl.js";

/**
 * Why a child-run summary is not the whole picture. Closed; see this module's
 * header for the provenance of each member and for the near-misses that were
 * deliberately not reused.
 */
export type ChildRunIncompleteCause = "detail_fetch_failed" | "pending_backfill" | "compacted";

/**
 * Whether a summary row reflects the child run's full activity, and if not,
 * why and as of when.
 *
 * `cause` and `observedAt` are required exactly on the `incomplete` arm and
 * refused on the `complete` one — both arms are `.strict()`, so a row cannot
 * claim completeness while carrying a cause, nor claim incompleteness without
 * naming one.
 */
export type ChildRunCompleteness =
  | { state: "complete" }
  | { state: "incomplete"; cause: ChildRunIncompleteCause; observedAt: string };

/**
 * Runtime validator for {@link ChildRunCompleteness}.
 *
 * `observedAt` is required on the incomplete arm because two of the three
 * causes are transient: a consumer deciding whether to retry and a renderer
 * deciding whether to age the notice both need to know how old the reading is.
 * A cause with no time attached is unactionable.
 */
export const ChildRunCompletenessSchema: z.ZodType<ChildRunCompleteness> = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("complete") }).strict(),
    z
      .object({
        state: z.literal("incomplete"),
        cause: z.enum(["detail_fetch_failed", "pending_backfill", "compacted"]),
        observedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  ],
);

/**
 * The closed cause set, as a value. Typed from {@link ChildRunIncompleteCause}
 * rather than from a hand-copied list, so a member added to the type without a
 * matching entry here fails to compile; the paired test additionally asserts
 * this list and the schema's accepted set agree, which catches the reverse.
 */
export const CHILD_RUN_INCOMPLETE_CAUSES: readonly ChildRunIncompleteCause[] = Object.freeze([
  "detail_fetch_failed",
  "pending_backfill",
  "compacted",
] as const);

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
  /**
   * On the `incomplete` arm of {@link completeness} this is a LOWER BOUND: the
   * count this daemon currently holds, not the child run's true total, which
   * by definition it cannot know while rows are missing.
   */
  eventCount: number;
  completeness: ChildRunCompleteness;
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
    completeness: ChildRunCompletenessSchema,
  })
  .strict();
