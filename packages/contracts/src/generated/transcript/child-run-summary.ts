// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The summarized child-run projection a transcript row carries and `transcript.childRun.expand` expands.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { RunId } from "../run/id.js";
import type { RunState } from "../run/state.js";

/**
 * Why a child-run summary is not the whole picture. Closed; a context compaction is not one.
 */
export type ChildRunIncompleteCause = "detailFetchFailed";
/**
 * Whether a summary row reflects the child run's full activity, and if not, why and as of when.
 * `observedAt` is required because the cause is transient: a retry decision and the age of the
 * notice both need to know how old it is.
 */
export type ChildRunCompleteness =
  | {
      state: "complete";
    }
  | {
      state: "incomplete";
      /**
       * Why.
       */
      cause: ChildRunIncompleteCause;
      /**
       * When the daemon noticed.
       */
      observedAt: WireInstant;
    };

/**
 * The summarized child-run projection: its parent, state, event count and completeness. No run
 * is its own parent.
 */
export interface ChildRunSummary {
  /**
   * The child run.
   */
  runId: RunId;
  /**
   * The run that started it; never the child itself.
   */
  parentRunId: RunId;
  /**
   * The child's state.
   */
  state: RunState;
  /**
   * How many events the daemon holds for it; on the `incomplete` arm a lower bound.
   */
  eventCount: number;
  /**
   * Whether the summary is the whole picture.
   */
  completeness: ChildRunCompleteness;
}

export {
  validateChildRunCompleteness,
  validateChildRunIncompleteCause,
  validateChildRunSummary,
} from "../checks/transcript/child-run-summary.js";
