// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Where a run stands, the state it starts in and the states it ends in.

/**
 * The state a run is created in. No state change enters it, so the event entering it creates
 * a run.
 */
export const RUN_INITIAL_STATE = "queued" as const;

/** The states a run ends in; the event entering one is the terminal record of its run version. */
export const RUN_TERMINAL_STATES = ["completed", "interrupted", "stopped", "failed"] as const;

/**
 * Where a run stands. `pausing` is the step in flight finishing after a pause was asked for; the
 * run reads `paused` once nothing runs. `stopped` is a child ended for good by a stop that reached
 * several agents; a provider whose stop leaves a child resumable reads `interrupted` instead.
 */
export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waitingForApproval"
  | "waitingForInput"
  | "pausing"
  | "paused"
  | "completed"
  | "interrupted"
  | "stopped"
  | "failed";

export { validateRunState } from "../checks/run/state.js";
