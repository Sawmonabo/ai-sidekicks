// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The hold on starting new runs: one per daemon over its whole scheduler, and how many starts wait behind it.

/**
 * The `workflow.newRunHold.update` input: the hold on starting new runs, one per daemon over its
 * whole scheduler. A run already going finishes; every new start waits until the hold is off.
 */
export interface WorkflowNewRunHoldUpdateRequest {
  /**
   * Whether the hold is on.
   */
  held: boolean;
}
/**
 * The hold and how many starts wait behind it, as the `workflow.newRunHold.update` reply and the
 * `workflow.subscribe` stream carry it.
 */
export interface WorkflowNewRunHoldState {
  /**
   * Whether the hold is on.
   */
  held: boolean;
  /**
   * How many starts wait behind it.
   */
  waitingStartCount: number;
}

export {
  validateWorkflowNewRunHoldState,
  validateWorkflowNewRunHoldUpdateRequest,
} from "../../checks/workflow/run/new-run-hold.js";
