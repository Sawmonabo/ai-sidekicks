// The one wake-up a wall-clock deadline gets.
//
// MOST FIGURES ON A CONSOLE SURFACE ARE AGES, and an age is only ever wrong by how
// long ago the surface read. A DEADLINE is not: crossing it changes what the row
// SAYS — a clone goes from "scheduled for disposal" to "past its disposal time, and
// the snapshot refs may already be gone", an invite from live to expired, a lease
// from held to lapsed. A surface rendering against the instant of its last read
// therefore keeps the pre-deadline sentence for as long as the window stays open,
// which is exactly the state a person leaves a session in.
//
// AND THE FIX IS NOT A POLL. `Spec-023 §Console Design (Meridian)`'s "No interval
// polling" rule and the idle-CPU budget behind it both hold, so this arms ONE
// timeout at a time, for the earliest deadline still ahead, and re-arms from inside
// its own tick: a chain of single shots that stops on its own the moment nothing is
// outstanding. A deadline further out than a platform timer can hold is walked in
// steps of that ceiling rather than armed for in one go — see
// `MAXIMUM_TIMEOUT_MILLISECONDS`, where a single unclamped arm fires immediately and
// forever. Nothing is read when it fires — it publishes an INSTANT — which is
// why this is not a refresh and does not belong to `scheduling.ts` beside it. That
// module decides when to ask the daemon again; this one decides nothing at all
// except what time it is for the rows already in hand.
//
// THE DEPENDENCY IS THE DEADLINE, NOT THE ARRAY. Every family that wrote this by
// hand keyed its effect on the record array, so a caller that rebuilt the array each
// render — a `.map` over a store selection, which is the ordinary case — cancelled
// and re-armed a timer on every single render. The earliest future deadline is a
// NUMBER, and a number is what the effect depends on here, so an array with the same
// contents re-arms nothing and the steady path allocates nothing.
//
// THE INSTANT ONLY EVER MOVES FORWARD. It starts at the clock's reading when the
// consumer mounts and advances to each deadline as that deadline is crossed — never
// to the clock's own reading at the moment the timer fired, which would put an
// instant on screen that no threshold in the caller's list corresponds to. A caller
// with a read stamp of its own takes the later of the two, so a fresh read always
// wins and the ages beside the countdown stay the read's own.

import { useEffect, useState } from "react";

import type { ConsoleClock, ScheduledHandle } from "../core/index.js";

/**
 * The largest delay a platform timer holds, and therefore the largest step this
 * module ever arms.
 *
 * `setTimeout` stores its delay in a signed 32-bit integer, so a delay above this
 * does not fire late — it fires on the NEXT TICK. Measured on Node 22:
 * `setTimeout(fn, 2 ** 31)` warns `TimeoutOverflowWarning` and runs `fn` two
 * milliseconds later. A deadline more than about 24.8 days out is ordinary here — a
 * clone scheduled for disposal in two months, an invitation good for a quarter — so
 * an unclamped delay would publish that far-future instant immediately and render
 * every row in the list past its deadline, permanently: with the instant beyond
 * every threshold, nothing is outstanding and nothing re-arms.
 *
 * It is a platform constant rather than a console cap, which is why it lives beside
 * the one module that arms against it rather than in the caps table.
 */
const MAXIMUM_TIMEOUT_MILLISECONDS = 2_147_483_647;

/**
 * The soonest deadline still ahead of `nowMilliseconds`, or `undefined`.
 *
 * Pure and exported, so the arming rule is provable by driving it rather than by
 * reaching into the hook. A deadline already behind needs no wake-up — the instant
 * the caller is rendering against is already past it — and a value that is not a
 * finite instant is skipped rather than armed for, because a timer scheduled against
 * `NaN` fires immediately and forever.
 */
export function earliestFutureDeadline(
  deadlines: readonly number[],
  nowMilliseconds: number,
): number | undefined {
  let earliestMilliseconds: number | undefined;
  for (const deadline of deadlines) {
    if (!Number.isFinite(deadline) || deadline <= nowMilliseconds) {
      continue;
    }
    if (earliestMilliseconds === undefined || deadline < earliestMilliseconds) {
      earliestMilliseconds = deadline;
    }
  }
  return earliestMilliseconds;
}

/**
 * The instant a surface renders against, woken once at each outstanding deadline.
 *
 * The clock is the caller's rather than this module's, on the console's one clock
 * rule: a surface that constructed its own would be a second time base beside the
 * scenario's frozen one, and a frozen tick only names one exact frame if nothing
 * reaches past it. Under the fixture the clock passed in is the scenario's, so a
 * screenshot's countdowns are byte-stable.
 *
 * At most one timeout is armed for the whole consumer, and none at all when nothing
 * is outstanding — which is what makes `ManualClock.pendingCount === 0` a checkable
 * statement about an idle console rather than an assertion about one.
 */
export function useDeadlineWake(clock: ConsoleClock, deadlines: readonly number[]): number {
  // Read once, at mount. A render body that read the clock on every pass would be a
  // render whose output depends on when it ran, which is the impurity the frozen
  // clock exists to remove.
  const [wokeAtMilliseconds, setWokeAtMilliseconds] = useState(() => clock.now());
  const dueAtMilliseconds = earliestFutureDeadline(deadlines, wokeAtMilliseconds);

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
        // The deadline itself, and never the clock's reading of now: the caller's
        // rows turn on whether that instant has passed, and waking to a later one
        // would cross thresholds nobody in the list is measured against. `Math.max`
        // rather than a bare assignment because two consumers of one clock can
        // settle out of order and the instant is monotone by construction.
        setWokeAtMilliseconds((heldMilliseconds) => Math.max(heldMilliseconds, dueAtMilliseconds));
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
  }, [clock, dueAtMilliseconds]);

  return wokeAtMilliseconds;
}
