// Advancing the one frozen clock a console reading schedules against.
//
// Every read this console performs goes through a `RefreshScheduler`, and every
// scheduler is armed on the clock `consoleClockFor` resolves — the fixture's frozen
// one wherever a scenario is playing. So a suite that mounts a reading and asserts
// what it asked the daemon has to MOVE that clock, and moving it is three things at
// once: reaching the right clock, advancing it far enough that the absolute deadline
// fires rather than only the debounce, and letting the call's own promise chain
// settle inside `act` so React has committed what the answer changed.
//
// Written once because four suites need it. Each hand-rolled copy had its own idea of
// how far to advance and how many microtasks to drain, which is how one of them came
// to advance by the debounce and pass only because its case asked exactly once.

import { act } from "@testing-library/react";

import { ManualClock, REFRESH_MAX_WAIT_MS } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";

/**
 * The frozen clock this bridge's readings schedule against.
 *
 * Throws rather than falling back to a real clock: a suite whose bridge carried no
 * frozen clock would advance nothing, wait out no window, and report the absence of a
 * read it never gave the scheduler a chance to perform.
 */
export function frozenClockOf(bridge: ConsoleBridge): ManualClock {
  const { clock } = bridge.scenarioEngine ?? {};
  if (!(clock instanceof ManualClock)) {
    throw new Error("this bridge carries no frozen clock, so no scheduled read can be settled");
  }
  return clock;
}

/**
 * Let the scheduler's window elapse and the read that follows it settle.
 *
 * The ABSOLUTE deadline rather than the debounce, so a case that asked more than once
 * still reaches a performed read: a continuous stream of reasons keeps pushing the
 * debounce out, and the deadline measured from the first request is what stops that
 * from postponing the read forever.
 */
export async function settleScheduledRead(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    frozenClockOf(bridge).advance(REFRESH_MAX_WAIT_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}
