// What a tree termination is allowed to spend: the deadline it re-reads, and the
// host queries every enclosing per-test budget has to reserve for it.
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
//
// AND THE READINGS THAT SIT INSIDE NOBODY'S DEADLINE ARE RESERVED HERE
//
// A managed child performs host queries that no termination's budget contains:
// the root's start stamp at the spawn, the descendant capture its owner takes
// while the child is up, and the intersection the root's `exit` runs. Each of
// those is a `spawnSync` bounded at `HOST_QUERY_TIMEOUT_MS` and each blocks the
// thread vitest's own timeout runs on, so an enclosing per-test budget that does
// not RESERVE them is a budget the generic timeout wins inside — the harness's
// diagnostic path is never reached and the child it was going to describe is torn
// down with the worker. Every spawner therefore derives its enclosure from
// `SPAWNED_TREE_HOST_QUERY_CEILING_MS` rather than writing a figure down, and
// `probe-budget-derivation.test.ts` is what holds the containment.
//
// The reservation is PLATFORM-CONDITIONAL because the cost is. Only the Windows
// arm consumes a captured descendant set — the POSIX arm addresses the process
// group and reads no capture at all — so on POSIX those two readings are never
// taken and reserving for them would inflate every enclosure for a query that
// cannot happen. One predicate decides both, which is the whole reason it is a
// constant rather than a sentence in two comments.

import process from "node:process";

import { HOST_QUERY_TIMEOUT_MS } from "./readers.js";

/**
 * Whether this platform's tree kill is addressed through a CAPTURED member set.
 *
 * The one predicate behind three things that must agree: which arm
 * `dispatch.ts` takes, whether `identity.ts` reads a listing at all, and how much
 * of an enclosing per-test budget is reserved for those readings. Windows has no
 * process group, so `taskkill /pid <root> /t` rediscovers a tree by walking down
 * from the root — and a root that has exited hands it nothing, which is why the
 * capture exists there and why nothing on POSIX reads one.
 */
export const TERMINATION_CONSUMES_CAPTURED_DESCENDANTS: boolean = process.platform === "win32";

/**
 * The descendant listings ONE managed child takes outside any termination budget.
 *
 * Two, and they are named rather than counted: the owner's live capture, taken
 * once while the child has not yet reported an exit, and the intersection the
 * root's `exit` runs over what that capture recorded. A third reading added here
 * without moving this figure is a reading no enclosure has room for.
 */
export const DESCENDANT_LISTINGS_PER_CHILD = 2;

/**
 * What a managed child's own host queries may cost, per enclosing per-test budget.
 *
 * A FUNCTION so both arms are checkable from either platform. The suite runs
 * where the descendant readings are never taken, so a constant alone would leave
 * the arithmetic that matters on Windows unasserted anywhere — and this is
 * arithmetic, which is the one kind of claim a test can make about the other
 * platform without being on it.
 *
 * The root's start stamp is charged on every platform because it is read on every
 * platform: `SpawnedTreeIdentity`'s constructor takes it at the spawn, before any
 * harness has armed the timer bounding its own phases.
 */
export function spawnedTreeHostQueryCeilingMs(consumesCapturedDescendants: boolean): number {
  const descendantListings = consumesCapturedDescendants ? DESCENDANT_LISTINGS_PER_CHILD : 0;
  return HOST_QUERY_TIMEOUT_MS * (1 + descendantListings);
}

/**
 * The reserve every spawner's enclosing budget keeps for this host's own queries.
 *
 * A PHASE OF THE TEST THAT NO SPAWN DEADLINE CONTAINS. The capture runs inside
 * `spawnManagedElectronChild`, which is to say before the probe harness that
 * called it has armed the timer bounding its spawn — so a host whose `ps` or
 * PowerShell answers slowly spends this here and the harness's own spawn budget
 * still starts at zero afterwards. Reserving only the later phases therefore left
 * the worst legal run outside its enclosure: on the GC probe's figures, 5 s of
 * query plus a 30 s spawn budget plus the termination grace plus the reserve is
 * 40 s against a 35 s enclosure, and vitest's generic timeout wins before the
 * harness's own diagnostic path settles.
 *
 * It is spelled in `HOST_QUERY_TIMEOUT_MS` rather than as a figure beside it,
 * because each reading's cost IS that bound — the query is `spawnSync`'s and the
 * timeout is what abandons it. Named here rather than in each harness so the two
 * derived budgets add a term that says WHICH phase it pays for, and so a change
 * to the query bound moves both of them in one edit.
 */
export const SPAWNED_TREE_HOST_QUERY_CEILING_MS: number = spawnedTreeHostQueryCeilingMs(
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS,
);

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
