// The one wake-up a wall-clock deadline gets.
//
// MOST FIGURES ON A CONSOLE SURFACE ARE AGES, and an age is only ever wrong by how
// long ago the surface read. A DEADLINE is not: crossing it changes what the row
// SAYS — a clone goes from "scheduled for disposal" to "past its disposal time, and
// the snapshot refs may already be gone", a lease from held to lapsed. A surface rendering against the instant of its last read
// therefore keeps the pre-deadline sentence for as long as the window stays open,
// which is exactly the state a person leaves a session in.
//
// AND THE FIX IS NOT A POLL. The no-interval-polling rule and the idle-CPU budget
// behind it both hold, so this arms ONE timeout at a time, for the earliest deadline
// still ahead, and re-arms from inside its own tick: a chain of single shots that stops
// on its own the moment nothing is outstanding. A deadline further out than a platform
// timer can hold is walked in steps of that ceiling rather than armed for in one go —
// see `MAXIMUM_TIMEOUT_MILLISECONDS`, where a single unclamped arm fires immediately
// and forever. Nothing is read when it fires — it publishes an INSTANT — which is why
// this is not a refresh and does not belong to `read/refresh-scheduler.ts`. That module
// decides when to ask the daemon again; this one decides nothing at all except what
// time it is for the rows already in hand.
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

export { useDeadlineWake } from "@renderer/hooks/useDeadlineWake.js";

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
