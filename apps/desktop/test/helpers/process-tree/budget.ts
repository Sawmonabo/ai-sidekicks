// What is left of a caller's deadline, as one object every command re-reads.
//
// THE ROLE, AND WHY IT IS NOT A NUMBER. `readers.ts` bounds ONE host command: it
// takes the smaller of `HOST_QUERY_TIMEOUT_MS` and what it is handed, and it
// spawns nothing at all once that reaches zero. That is exactly right for one
// command and says nothing whatever about a SEQUENCE of them — and a tree kill
// is a sequence. The Windows arm alone runs the root's start-stamp read, the
// whole-host process-table listing, a `taskkill` per addressable member, and a
// liveness reading per member, each of them a `spawnSync` this thread blocks on.
//
// Handed the same NUMBER, every one of those is entitled to the whole remainder.
// `taskkill` can spend it and the fallback listing after it can spend it again,
// so one `terminateProcessTree` call overruns the deadline it was given before
// its caller gets the clock back — and that caller is `BoundedCleanup`, whose
// next act is to re-read the clock and decide whether another attempt fits.
// Vitest's own timeout runs on this same blocked thread, so the overrun is paid
// in the one currency that loses the verdict: the `unterminable` settlement and
// the profile removal are never reached at all.
//
// So the remainder is held as an ABSOLUTE INSTANT and subtracted afresh before
// every command. The sum of what the commands are charged is then the deadline
// itself rather than a multiple of it, whatever the sequence turns out to be —
// the property a snapshot cannot have and a re-read cannot lose.
//
// UNBOUNDED IS A VALUE HERE AND NOT AN ABSENCE. Most callers hold no deadline:
// the capture taken at a spawn is inside nobody's disposal. Such a budget
// answers `undefined` forever, which is what `readers.ts` already reads as "your
// own ceiling", so a caller that never asked for a bound is never given one.

/**
 * One deadline, shared by every host command a single termination runs.
 *
 * A class rather than a closure over a number because it holds state — the
 * instant it expires — and because the clock is a seam a case supplies rather
 * than one it waits on: the state this exists for is a host query spending its
 * whole five-second ceiling, which no test can afford to produce for real and
 * no runner produces on demand.
 */
export class HostCommandBudget {
  readonly #expiresAt: number | undefined;
  readonly #readClock: () => number;

  /**
   * @param remainingBudgetMilliseconds What is LEFT of the caller's own deadline,
   *   or `undefined` for a caller that holds none.
   * @param readClock How the instant is read, injected for the reason above.
   */
  constructor(remainingBudgetMilliseconds?: number, readClock: () => number = Date.now) {
    this.#readClock = readClock;
    this.#expiresAt =
      remainingBudgetMilliseconds === undefined
        ? undefined
        : readClock() + remainingBudgetMilliseconds;
  }

  /**
   * What the next command may spend, read at the moment it is asked.
   *
   * NEVER NEGATIVE, and that floor is load-bearing rather than tidy: the shared
   * door refuses a bound at or below zero by spawning nothing, and a figure that
   * had run past zero would arrive there as an ever-larger negative number
   * meaning the same thing less legibly. Zero is the honest answer to "you have
   * no time left", and it is the answer that keeps a caller escalating rather
   * than one that reports a tree clean because there was no time to look.
   */
  remainingMilliseconds(): number | undefined {
    if (this.#expiresAt === undefined) {
      return undefined;
    }
    return Math.max(0, this.#expiresAt - this.#readClock());
  }
}
