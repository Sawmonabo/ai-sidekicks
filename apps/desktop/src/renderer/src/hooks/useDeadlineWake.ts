import { useEffect, useRef } from "react";

import { useSubjectScopedState } from "./subject-scoped/useSubjectScopedState.js";
import type { Clock, ScheduledHandle } from "@renderer/lib/clock.js";
import { earliestFutureDeadline, latestPassedDeadline } from "@renderer/lib/deadlines.js";

/**
 * The largest delay a platform timer holds, and so the largest step this module arms.
 *
 * `setTimeout` stores its delay in a signed 32-bit integer; a larger delay is set to 1 (with
 * a `TimeoutOverflowWarning`) and fires on the next tick. A deadline more than about 24.8
 * days out is ordinary here (a clone disposed in two months), and an unclamped delay would
 * publish that far-future instant at once and render every row past its deadline for good,
 * with nothing outstanding to re-arm. A platform constant, not a console cap.
 */
const MAXIMUM_TIMEOUT_MILLISECONDS = 2_147_483_647;

/**
 * The instant a component renders against, woken once at each outstanding deadline.
 *
 * The clock is the caller's, so under a fixture it is the scenario's frozen one and a
 * screenshot's countdowns are byte-stable. A replacement clock is a new time base: the
 * instant is re-read from it during the render that first sees it, since the previous
 * clock's reading would put every deadline behind the component. At most one timeout is
 * armed for the whole consumer, and none when nothing is outstanding, which makes
 * `ManualClock.pendingCount === 0` a checkable statement about an idle console.
 */
export function useDeadlineWake(clock: Clock, deadlines: readonly number[]): number {
  // Read once per clock, during the render that first sees one: reading on every pass would
  // make the output depend on when it ran, and reading only at mount would hold one clock's
  // reading against another's deadlines. An instant is a value a drop releases, so there is
  // nothing to dispose.
  const { value: wokeAtMilliseconds, publish: publishInstant } = useSubjectScopedState<number>(
    clock,
    undefined,
    () => clock.now(),
  );
  const dueAtMilliseconds = earliestFutureDeadline(deadlines, wokeAtMilliseconds);
  // The live list, reachable from the effect without joining its dependencies: the effect
  // depends on the earliest deadline as a number, so an array rebuilt with the same contents
  // re-arms nothing.
  const deadlinesRef = useRef(deadlines);
  deadlinesRef.current = deadlines;

  useEffect(() => {
    if (dueAtMilliseconds === undefined) {
      return undefined;
    }
    // One deadline, armed in steps no longer than a timer can hold. Each step asks the clock
    // again, so a late step or a host that slept moves the wake-up nowhere.
    let armedHandle: ScheduledHandle | undefined;
    const armNextStep = (): void => {
      const remainingMilliseconds = dueAtMilliseconds - clock.now();
      if (remainingMilliseconds <= 0) {
        armedHandle = undefined;
        // A deadline from the caller's own list, never the clock's reading of now, so the
        // caller's rows cross their threshold. The last one crossed, not the first, so a
        // wake-up that arrives after several settles all of them. `Math.max` because two
        // consumers of one clock can settle out of order.
        const crossedMilliseconds =
          latestPassedDeadline(deadlinesRef.current, clock.now()) ?? dueAtMilliseconds;
        publishInstant((heldMilliseconds) => Math.max(heldMilliseconds, crossedMilliseconds));
        return;
      }
      armedHandle = clock.scheduleTimeout(
        armNextStep,
        Math.min(remainingMilliseconds, MAXIMUM_TIMEOUT_MILLISECONDS),
      );
    };
    armNextStep();
    return () => {
      // Canceled when the earliest deadline changes, when the wake-up has landed, and on
      // unmount, so no timeout sets state on a component that is gone.
      if (armedHandle !== undefined) {
        clock.cancel(armedHandle);
      }
    };
    // `publishInstant` is captured per addressing, so it moves exactly when the clock does; a
    // publisher from a clock the consumer has left writes nowhere.
  }, [clock, dueAtMilliseconds, publishInstant]);

  return wokeAtMilliseconds;
}
