// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The arguments of the tools the daemon serves the providers on its own tool route.

/**
 * `task_output`: the status of a tool call that moved to the background and, once it ends, its
 * result. `wait_seconds` is how long the model asks to wait; the daemon waits at most 10 s.
 */
export interface TaskOutputArguments {
  /**
   * The id of the background call, as the call that moved it returned it: at least one character that is not whitespace, with no NUL character.
   */
  task_id: string;
  /**
   * Optional. How long to wait for the call to end, in seconds: a number at or above 0; the wait stops at 10 seconds.
   */
  wait_seconds?: number;
}
/**
 * `task_stop`: cancels a tool call that moved to the background.
 */
export interface TaskStopArguments {
  /**
   * The id of the background call, as the call that moved it returned it: at least one character that is not whitespace, with no NUL character.
   */
  task_id: string;
}
