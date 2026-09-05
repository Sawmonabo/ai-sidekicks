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
// THE INSTANT ONLY EVER MOVES FORWARD, WITHIN ONE CLOCK. It starts at that clock's
// reading when the consumer mounts and advances to each deadline as that deadline is
// crossed — never to the clock's own reading at the moment the timer fired, which
// would put an instant on screen that no threshold in the caller's list corresponds
// to. A caller with a read stamp of its own takes the later of the two, so a fresh
// read always wins and the ages beside the countdown stay the read's own.
//
// AND THE CLOCK IS THE SUBJECT, because an instant read from one says nothing about
// another. A mounted consumer handed a replacement — a fixture scenario switching to
// one that starts earlier is the ordinary way it happens — kept the reading it took
// from the clock it no longer has, so every deadline on the new clock was already
// behind it: nothing armed, and every row rendered past its deadline for as long as
// the surface stayed mounted. Monotonicity is a property of one time base, so the
// instant is held per clock through `subject-scoped-state.ts` and re-seeded during
// the render that first sees a replacement rather than one frame later.

import { useEffect, useRef } from "react";

import type { ConsoleClock, ScheduledHandle } from "../core/index.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

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
 * disposal in two months, an invitation good for a quarter — so an unclamped delay
 * would publish that far-future instant immediately and render every row in the list
 * past its deadline, permanently: with the instant beyond every threshold, nothing
 * is outstanding and nothing re-arms.
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
/**
 * The LATEST deadline at or behind `nowMilliseconds`, or `undefined`.
 *
 * The catch-up half of the rule above, and the reason it exists: a wake-up that
 * arrives long after the deadline it was armed for has usually crossed several, and
 * publishing only the earliest of them settles one boundary per render — the next
 * pass arms for the next crossed deadline, finds it already behind, and publishes
 * again. A host that slept, a tab that was backgrounded, and a scenario advanced by
 * three quarters of an hour all reach that shape, and the last of them reaches
 * React's nested-update ceiling before the figure on screen is current.
 *
 * The published instant is still a deadline the caller's own list carries and still
 * one the clock has passed, so nothing here renders an instant no threshold
 * corresponds to — the property the arming comment states. It renders the LAST one
 * crossed instead of the first, which is the reading a person looking at the surface
 * after the sleep is owed.
 */
export function latestPassedDeadline(
  deadlines: readonly number[],
  nowMilliseconds: number,
): number | undefined {
  let latestMilliseconds: number | undefined;
  for (const deadline of deadlines) {
    if (!Number.isFinite(deadline) || deadline > nowMilliseconds) {
      continue;
    }
    if (latestMilliseconds === undefined || deadline > latestMilliseconds) {
      latestMilliseconds = deadline;
    }
  }
  return latestMilliseconds;
}

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
