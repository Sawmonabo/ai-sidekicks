import { useEffect, useRef } from "react";

import { useSubjectScopedState } from "./subject-scoped/useSubjectScopedState.js";
import type { ConsoleClock, ScheduledHandle } from "@renderer/lib/clock.js";
import { earliestFutureDeadline, latestPassedDeadline } from "@renderer/lib/deadlines.js";

/**
 * The largest delay a platform timer holds, and therefore the largest step this
 * module ever arms.
 *
 * `setTimeout` stores its delay in a signed 32-bit integer, so a delay above this
 * does not fire late — it fires on the NEXT TICK. Measured on Node 22: a delay of
 * `2 ** 31` warns `TimeoutOverflowWarning`, reports that the duration was set to 1,
 * and runs the callback two milliseconds later. The call form is deliberately not
 * spelled out above — the timer chokepoint gate reads source text, and a call in a
 * comment is indistinguishable from a call.
 *
 * A deadline more than about 24.8 days out is ordinary here — a clone scheduled for
 * disposal in two months, a lease held for a quarter — so an unclamped delay
 * would publish that far-future instant immediately and render every row in the list
 * past its deadline, permanently: with the instant beyond every threshold, nothing
 * is outstanding and nothing re-arms.
 *
 * It is a platform constant rather than a console cap, which is why it lives beside
 * the one module that arms against it rather than in the caps table.
 */
const MAXIMUM_TIMEOUT_MILLISECONDS = 2_147_483_647;

/**
 * The instant a surface renders against, woken once at each outstanding deadline.
 *
 * The clock is the caller's rather than this module's, on the console's one clock
 * rule: a surface that constructed its own would be a second time base beside the
 * scenario's frozen one, and a frozen tick only names one exact frame if nothing
 * reaches past it. Under the fixture the clock passed in is the scenario's, so a
 * screenshot's countdowns are byte-stable.
 *
 * A REPLACEMENT CLOCK IS A NEW TIME BASE, and the instant is re-read from it during
 * the render that first sees it: the previous clock's reading measures nothing on
 * this one, and holding it would put every deadline behind the surface at once.
 *
 * At most one timeout is armed for the whole consumer, and none at all when nothing
 * is outstanding — which is what makes `ManualClock.pendingCount === 0` a checkable
 * statement about an idle console rather than an assertion about one.
 */
export function useDeadlineWake(clock: ConsoleClock, deadlines: readonly number[]): number {
  // Read once per CLOCK, during the render that first sees one. A render body that
  // read the clock on every pass would be a render whose output depends on when it
  // ran, which is the impurity the frozen clock exists to remove; a cell that read it
  // only at mount would hold one clock's reading against another's deadlines. The
  // subject holder is exactly that distinction, and the plain form of it — an instant
  // is a value a drop releases, so there is nothing here to dispose.
  const { value: wokeAtMilliseconds, publish: publishInstant } = useSubjectScopedState<number>(
    clock,
    undefined,
    () => clock.now(),
  );
  const dueAtMilliseconds = earliestFutureDeadline(deadlines, wokeAtMilliseconds);
  // The live list, reachable from inside the effect without joining its dependencies.
  // The effect deliberately depends on the earliest deadline as a NUMBER, so an array
  // rebuilt with the same contents re-arms nothing; a ref is what lets the catch-up
  // below read every deadline without giving that property up.
  const deadlinesRef = useRef(deadlines);
  deadlinesRef.current = deadlines;

  useEffect(() => {
    if (dueAtMilliseconds === undefined) {
      return undefined;
    }
    // One deadline, armed in steps no longer than a timer can hold. Each step asks
    // the clock again rather than counting its own, so a step that ran late or a
    // host that slept moves the wake-up nowhere: the remaining time is always the
    // difference between the deadline and what the clock says now.
    let armedHandle: ScheduledHandle | undefined;
    const armNextStep = (): void => {
      const remainingMilliseconds = dueAtMilliseconds - clock.now();
      if (remainingMilliseconds <= 0) {
        armedHandle = undefined;
        // A deadline the caller's own list carries, and never the clock's reading of
        // now: the caller's rows turn on whether that instant has passed, and waking
        // to one nothing is measured against would cross no threshold in the list.
        // The LAST one crossed rather than the first, because a wake-up that arrives
        // after several settles all of them here or settles one per render until the
        // ceiling. `Math.max` rather than a bare assignment because two consumers of
        // one clock can settle out of order and the instant is monotone by
        // construction.
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
      // Cancelled when the earliest deadline changes, when the wake-up has landed,
      // and when the consumer unmounts — a timeout that outlived its surface would
      // set state on a component that is gone.
      if (armedHandle !== undefined) {
        clock.cancel(armedHandle);
      }
    };
    // `publishInstant` is captured per addressing rather than per render, so it moves
    // exactly when the clock does — the same fact the first dependency names, and a
    // publisher from a clock the consumer has left writes nowhere by construction.
  }, [clock, dueAtMilliseconds, publishInstant]);

  return wokeAtMilliseconds;
}
