// `ChildRunSummary`, the summarized child-run projection a timeline row
// carries and `timeline.childRunExpand` expands. Child-run activity defaults
// to summarized rows with explicit expansion.
//
// WHY THIS MODULE IS THE SUBDIRECTORY'S LEAF. `child-run-summary.ts` imports
// nothing from its siblings, `row.ts` imports it, `operations.ts` imports
// both, and `methods.ts` imports `operations.ts`. Every module in this package
// is an eager module-scope Zod initializer, so a back-import would throw
// `ReferenceError` at import time rather than fail to compile (the worked case
// is documented in the `repo.ts` header). The one-way chain is what keeps that
// unreachable.
//
// THE INCOMPLETENESS MARKER. A child-run detail fetch that fails leaves the
// summary row visible and marked incomplete rather than disappearing.
//
// WHY A DISCRIMINATED MEMBER AND NOT A BOOLEAN. A bare `incomplete: true` says
// that something is missing without saying what, which leaves a consumer no
// basis to decide whether to retry. The member is also REQUIRED rather than
// optional: an absent marker would be a third state meaning "probably fine",
// and the rule is that incompleteness is STATED. A low `eventCount` alone is
// indistinguishable from a child run that genuinely did little.
//
// THE CAUSE SET IS CLOSED:
//   * `detail_fetch_failed` — a child-run detail fetch failed. Transient.
// A context compaction inside the child is not a cause: the session's log
// keeps every row the child wrote, so its summary stays whole across one.
// Deliberately NOT reused: `RepoMountHealth`'s `unreachable` (scoped to
// filesystem mounts, and its own module warns against overloading that word
// across axes).
import { z } from "zod";

import { RunIdSchema, type RunId } from "../provider-driver.js";
import { RunStateSchema, type RunState } from "../run-state.js";

/**
 * Why a child-run summary is not the whole picture. Closed; see this module's
 * header for the provenance of each member and for the near-misses that were
 * deliberately not reused.
 */
export type ChildRunIncompleteCause = "detail_fetch_failed";

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
 * `observedAt` is required on the incomplete arm because its cause is
 * transient: a consumer deciding whether to retry and a renderer
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
        cause: z.enum(["detail_fetch_failed"]),
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
 * Runtime validator for {@link ChildRunSummary}. `.strict()` — the member set
 * is closed, so a producer offering a sixth member (an incompleteness marker
 * among them) is refused here rather than silently stripped at the seam and
 * then missing from every consumer that expected it.
 *
 * NO RUN IS ITS OWN PARENT. `runId === parentRunId` makes the run-lineage
 * graph cyclic, and every consumer of that graph walks it: the renderer nests
 * a child row under its parent, the one-layer nesting rule is checked
 * against the chain, and cost attribution sums along it. A self-parenting row
 * turns each of those walks into a non-terminating loop, so it is refused at
 * the parse boundary rather than defended against separately at every walk.
 * `ChildRunExpandResponse` carries the same refusal on the same identity pair
 * — the shapes state one relationship, so they cannot disagree about it.
 */
export const ChildRunSummarySchema: z.ZodType<ChildRunSummary> = z
  .object({
    runId: RunIdSchema,
    parentRunId: RunIdSchema,
    state: RunStateSchema,
    // `.int()` is safe-integer in zod 4, which is the honest ceiling for a
    // tally: past it, distinct counts collapse onto one IEEE-754 double. No
    // separate cap constant — the counter form `run-control.ts` uses.
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
