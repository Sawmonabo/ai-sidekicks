// `ChildRunSummary`, the summarized child-run projection a timeline row carries and
// `timeline.childRunExpand` expands. A failed child-run detail fetch leaves the summary row
// visible and marked incomplete, with a required cause so a consumer can decide whether to
// retry; a low `eventCount` alone cannot be told from a run that did little.
//
// This module is the leaf of the subdirectory's import chain (child-run-summary, row,
// operations, methods). Every module is an eager module-scope Zod initializer, so a back-import
// would throw `ReferenceError` at import time instead of failing to compile.
import { z } from "zod";

import { RunIdSchema, type RunId } from "../provider-driver.js";
import { RunStateSchema, type RunState } from "../run-state.js";

/** Why a child-run summary is not the whole picture. Closed; a context compaction is not one. */
export type ChildRunIncompleteCause = "detail_fetch_failed";

/**
 * Whether a summary row reflects the child run's full activity, and if not, why and as of when.
 * `cause` and `observedAt` are required on the `incomplete` arm and refused on the `complete`
 * one, so a row cannot claim completeness with a cause or incompleteness without one.
 */
export type ChildRunCompleteness =
  | { state: "complete" }
  | { state: "incomplete"; cause: ChildRunIncompleteCause; observedAt: string };

/**
 * Parses a {@link ChildRunCompleteness}. `observedAt` is required because the cause is
 * transient: a retry decision and the age of the notice both need to know how old it is.
 */
export const ChildRunCompletenessSchema: z.ZodType<ChildRunCompleteness> = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("complete") }).strict(),
    z
      .object({
        state: z.literal("incomplete"),
        cause: z.enum(["detail_fetch_failed"]),
        observedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  ],
);

/** Every {@link ChildRunIncompleteCause}, as a value. */
export const CHILD_RUN_INCOMPLETE_CAUSES: readonly ChildRunIncompleteCause[] = Object.freeze([
  "detail_fetch_failed",
] as const);

/** The summarized child-run projection: its parent, state, event count and completeness. */
export interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  /**
   * On the `incomplete` arm of {@link completeness} this is a LOWER BOUND: the
   * count this daemon currently holds, not the child run's true total, which
   * by definition it cannot know while rows are missing.
   */
  eventCount: number;
  completeness: ChildRunCompleteness;
}

/**
 * Parses a {@link ChildRunSummary}. It is `.strict()`, so an unknown member is refused rather
 * than stripped. A run cannot be its own parent: a self-parenting row makes the run-lineage
 * graph cyclic and every walk of it non-terminating, so it is refused at the parse boundary.
 * `ChildRunExpandResponse` applies the same refusal.
 */
export const ChildRunSummarySchema: z.ZodType<ChildRunSummary> = z
  .object({
    runId: RunIdSchema,
    parentRunId: RunIdSchema,
    state: RunStateSchema,
    // `.int()` is safe-integer in zod 4, the honest ceiling for a tally, so no cap constant.
    eventCount: z.number().int().nonnegative(),
    completeness: ChildRunCompletenessSchema,
  })
  .strict()
  .superRefine((summary, issueContext) => {
    if (summary.runId === summary.parentRunId) {
      issueContext.addIssue({
        code: "custom",
        path: ["parentRunId"],
        message:
          "a child run cannot be its own parent: runId and parentRunId are equal, which makes " +
          "the run-lineage graph cyclic and any walk of it non-terminating",
      });
    }
  });
