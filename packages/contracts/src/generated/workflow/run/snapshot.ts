// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The two numbers that name one of a workflow run's snapshots: which execution of the run it belongs to, and which of that execution's approval pauses took it.

/**
 * Which execution of a run a snapshot belongs to: 0 for the first, one more at each re-run.
 */
export type WorkflowRunEpoch = number;
/**
 * Which approval pause of one execution took a snapshot, counted from 1.
 */
export type WorkflowRunPauseNumber = number;

export {
  validateWorkflowRunEpoch,
  validateWorkflowRunPauseNumber,
} from "../../checks/workflow/run/snapshot.js";
