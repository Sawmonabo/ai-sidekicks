// What the daemon's stop waits on and reports: each part's end within the stop's drain bound, and
// the terminals' drain.

import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";

import { waitWithin } from "../bounded-wait.js";
import type { DrainResult } from "../pty/host/contract.js";

/** The service-log line that says how the terminals drained at the stop. */
export function describeDrain(drain: DrainResult): string {
  return (
    `The terminals drained at the stop: ${String(drain.sessionsDrained)} ended, ` +
    `${String(drain.sessionsForcedKilled)} killed; the terminal host ` +
    `${drain.sidecarExitedCleanly ? "exited cleanly" : "did not exit cleanly"}` +
    `${drain.taskkillEscalated ? " and was killed" : ""}.`
  );
}

/**
 * Waits for `work` within the stop's drain bound: resolves `true` once it ended, its failure, if
 * any, added to `failures`, or `false` when the bound passed first.
 */
export async function endWithinDrainBound(
  work: Promise<unknown>,
  failures: unknown[],
): Promise<boolean> {
  const failure = work.then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (!(await waitWithin(failure, DAEMON_STOP_DRAIN_BOUND_MS))) {
    return false;
  }
  const ended = await failure;
  if (ended !== undefined) {
    failures.push(ended.error);
  }
  return true;
}
