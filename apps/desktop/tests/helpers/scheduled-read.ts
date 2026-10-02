// Advances the frozen clock an app reading schedules against.
//
// Every read goes through a `RefreshScheduler` armed on the clock the bridge resolution carries,
// the fixture's frozen one wherever a scenario plays. Moving it means reaching the right clock,
// advancing far enough that the absolute deadline fires and not only the debounce, and letting
// the call's promise chain settle inside `act` so React commits what the answer changed.

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_MAX_WAIT_MS } from "@renderer/lib/reads/refresh-caps.js";
import { settle } from "./settle.js";
import type { Clock } from "@renderer/lib/clock.js";

/**
 * The window's clock as the frozen clock its readings schedule against.
 *
 * Throws rather than falling back to a real clock: a window on no frozen clock would advance
 * nothing and report the absence of a read the scheduler never had a chance to perform.
 */
export function frozenClockOf(clock: Clock): ManualClock {
  if (!(clock instanceof ManualClock)) {
    throw new Error("this window runs on no frozen clock, so no scheduled read can be settled");
  }
  return clock;
}

/**
 * Let the scheduler's window elapse and the read that follows it settle.
 *
 * Advances the absolute deadline rather than the debounce: a continuous stream of reasons keeps
 * pushing the debounce out, and the deadline measured from the first request is what stops that
 * from postponing the read forever.
 */
export async function settleScheduledRead(clock: Clock): Promise<void> {
  const frozenClock = frozenClockOf(clock);
  await settle(() => {
    frozenClock.advance(REFRESH_MAX_WAIT_MS);
  });
}
