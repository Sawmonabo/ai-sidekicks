import type { WorkflowStepResolution } from "@ai-sidekicks/contracts/workflow/run/step/record";

/**
 * An answer this sitting gave a step, held until the run reads it back. `isWindowClock` is true
 * where its instant is the window's own clock standing in for the daemon's record, as a reply's is.
 */
export interface HeldStepAnswer {
  readonly resolution: WorkflowStepResolution;
  readonly isWindowClock: boolean;
}
