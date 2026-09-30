// The deadline a tree termination spends, and the host-query time every enclosing per-test
// budget must reserve for a managed child.
//
// The deadline is held as an absolute instant and re-read before every host command. A number
// copied to each command would let each one spend the whole remainder, so one termination could
// overrun the deadline before its caller got the clock back; vitest's own timeout runs on the
// same blocked thread, so the overrun would skip the `unterminable` settlement and the profile
// removal. Re-reading makes the charges sum to the deadline rather than a multiple of it.
//
// A caller with no deadline gets a budget that answers `undefined` forever, which
// `readers.ts` reads as "use your own ceiling".
//
// A managed child also runs host queries that no termination budget contains: the root's start
// stamp at the spawn, the owner's descendant capture, and the intersection the root's `exit`
// runs. Each is a `spawnSync` that blocks the thread vitest's timeout runs on, so an enclosing
// budget that does not reserve them lets the generic timeout win before the harness can report.
// Spawners derive their enclosure from `SPAWNED_TREE_HOST_QUERY_CEILING_MS`.
//
// The reservation depends on the platform: only the Windows arm consumes a captured descendant
// set, so on POSIX those two readings are never taken and reserving for them would only inflate
// every enclosure.

import process from "node:process";

import { HOST_QUERY_TIMEOUT_MS } from "./readers.js";

/**
 * Whether this platform's tree kill is addressed through a captured member set.
 *
 * One predicate decides which arm `termination.ts` takes, whether `identity.ts` reads a listing,
 * and how much of an enclosing budget is reserved for those readings. Windows has no process
 * group, so `taskkill /pid <root> /t` walks down from the root and finds nothing once the root
 * has exited; the capture exists for that case and POSIX never reads one.
 */
export const TERMINATION_CONSUMES_CAPTURED_DESCENDANTS: boolean = process.platform === "win32";

/**
 * The descendant listings one managed child takes outside any termination budget.
 *
 * Two: the owner's live capture and the intersection the root's `exit` runs. A third reading
 * needs this figure raised with it.
 */
export const DESCENDANT_LISTINGS_PER_CHILD = 2;

/**
 * What a managed child's own host queries may cost, per enclosing per-test budget.
 *
 * A function so both arms can be checked from either platform. The root's start stamp is charged
 * everywhere because `SpawnedTreeIdentity`'s constructor reads it at the spawn, before any
 * harness has armed its timer.
 */
export function spawnedTreeHostQueryCeilingMs(consumesCapturedDescendants: boolean): number {
  const descendantListings = consumesCapturedDescendants ? DESCENDANT_LISTINGS_PER_CHILD : 0;
  return HOST_QUERY_TIMEOUT_MS * (1 + descendantListings);
}

/**
 * The reserve every spawner's enclosing budget keeps for this host's own queries.
 *
 * The capture runs inside `spawnManagedElectronChild`, before the probe harness has armed the
 * timer that bounds its spawn, so a slow `ps` or PowerShell spends this time outside the
 * harness's own budget. Leaving it out of the enclosure let the worst legal run exceed it and
 * vitest's timeout win before the harness's diagnostic path settled. It is spelled in
 * `HOST_QUERY_TIMEOUT_MS` so a change to the query bound moves every derived budget together.
 */
export const SPAWNED_TREE_HOST_QUERY_CEILING_MS: number = spawnedTreeHostQueryCeilingMs(
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS,
);

/**
 * One deadline, shared by every host command a single termination runs.
 *
 * The clock is injectable because the state this exists for, a host query spending its whole
 * five-second ceiling, cannot be produced on demand in a test.
 */
export class HostCommandBudget {
  readonly #expiresAt: number | undefined;
  readonly #readClock: () => number;

  /**
   * @param remainingBudgetMilliseconds What is left of the caller's deadline, or `undefined`
   *   for a caller that holds none.
   * @param readClock How the instant is read.
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
   * Never negative: `runBoundedHostCommand` spawns nothing at or below zero, and zero keeps a
   * caller escalating rather than reporting a tree clean because there was no time to look.
   */
  remainingMilliseconds(): number | undefined {
    if (this.#expiresAt === undefined) {
      return undefined;
    }
    return Math.max(0, this.#expiresAt - this.#readClock());
  }
}
