// Work run in a window's idle time, which waits at most `IDLE_WAIT_MS` for it: a window drawing
// frame after frame may grant no idle time at all, so the work then runs anyway.

/**
 * Queues `task` for an idle moment of `view`, handing it the idle deadline; it runs once that
 * moment comes or `IDLE_WAIT_MS` has passed, whichever is first, `didTimeout` saying which.
 */
export function queueIdleTaskIn(view: Window, task: (deadline: IdleDeadline) => void): void {
  view.requestIdleCallback(task, { timeout: IDLE_WAIT_MS });
}

/** The longest a task waits for idle time before it runs anyway, in milliseconds. */
const IDLE_WAIT_MS = 50;
