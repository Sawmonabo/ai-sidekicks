// The stand-ins two cleanup suites drive, and why each one is a stand-in.
//
// Split out of `bounded-cleanup.test.ts` when that file passed 400 lines carrying
// two subjects — the settlement a close reaches, and what a REFUSED kill costs —
// which is the same split that file's own header records making once already. The
// scaffolding is what both subjects share: an application whose close never
// settles, a terminator that answers however a case needs, and a profile that
// records a removal rather than touching a disk.
//
// EVERY ONE OF THESE IS UNREACHABLE THROUGH THE REAL COLLABORATOR, which is why
// `BoundedCleanup` takes all of them as constructor arguments. No fixture makes a
// browser process refuse to close on demand, no `rmSync` over a directory this
// process owns fails on a POSIX runner, and no platform can be asked to refuse a
// kill. The terminator seam is more than a convenience: these cases run INSIDE
// the runner, and a terminator that really killed something would deliver to a
// whole process group — the launched tree only because playwright-core spawns
// detached, and somebody else's for any other pid it is handed.
//
// It is a `.test-support` module, so its only legitimate dependents are the
// suites beside it, which is what `test-support-has-no-shipping-reader` in
// `.dependency-cruiser.mjs` enforces.

import { type ClosableApplication, type ProcessTerminator } from "../cleanup-contract.js";
import { type LaunchProfile } from "../launch-profile.js";

/** A close bound short enough that exhausting it costs the suite nothing. */
export const TEST_BUDGET_MS = 120;

/**
 * What each REFUSED kill is given to leave nothing running, in these cases.
 *
 * Injected for `TEST_BUDGET_MS`'s reason and no other: the retry spends this in
 * full on every refusal, and the registered figure is seconds — a case that has
 * to exhaust the attempt bound cannot afford three of them.
 */
export const TEST_TERMINATION_WAIT_MS = 5;

/**
 * A grace interval deliberately LONGER than the whole close budget above.
 *
 * The one figure that separates a retry charged to that budget from one added
 * after it. At this length three added intervals dwarf the budget, so the two
 * shapes are hundreds of milliseconds apart rather than tens — which is what
 * makes the claim an assertion rather than a race against a loaded runner.
 */
export const TEST_OVERLONG_TERMINATION_WAIT_MS = 500;

/**
 * A clock a case advances by hand, so a probe can "spend" its ceiling for free.
 *
 * Hoisted here on the third suite that wanted one — the probe-budget cases, the
 * terminator-forwarding cases, and the slice derivation beside them — because a
 * clock is a ROLE and this package keeps one home per role. It is a class rather
 * than a closure for the reason every stateful helper here is: `read` is handed
 * to `BoundedCleanup` as its clock seam while `advance` stays the case's, and a
 * pair of closures over a shared `let` would be the module-level mutable state
 * the package rejects.
 */
export class SteppedClock {
  #nowMs: number;

  constructor(startMs = 1_000_000) {
    this.#nowMs = startMs;
  }

  readonly read = (): number => this.#nowMs;

  advance(byMs: number): void {
    this.#nowMs += byMs;
  }
}

/** What each seam member was handed, in the order it was handed it. */
export interface RecordedBudgets {
  readonly terminate: number[];
  readonly isRunning: number[];
}

/**
 * A terminator that refuses every kill and records the budget it was charged.
 *
 * `spendPerProbe` is what each reading costs the clock, which is how a case
 * makes a host query "spend its ceiling" without waiting five real seconds for
 * one — the state that motivated the whole charge and the one no real runner
 * produces on demand.
 */
export function budgetRecordingTerminator(
  clock: SteppedClock,
  recorded: RecordedBudgets,
  spendPerProbe: number,
): ProcessTerminator {
  return {
    terminate: (_processId: number, remainingBudgetMilliseconds: number) => {
      recorded.terminate.push(remainingBudgetMilliseconds);
      clock.advance(spendPerProbe);
      return false;
    },
    isRunning: (_processId: number, remainingBudgetMilliseconds: number) => {
      recorded.isRunning.push(remainingBudgetMilliseconds);
      clock.advance(spendPerProbe);
      return true;
    },
  };
}

/** An application whose close never settles, and whose process has a pid. */
export function applicationThatNeverCloses(processId: number | undefined): ClosableApplication {
  return { close: () => new Promise<void>(() => undefined), processId: () => processId };
}

/**
 * An application whose close never settles AND has already spent `spendMs`.
 *
 * The state the cleanup slice is sized for, and the one `applicationThatNeverCloses`
 * cannot produce against an injected clock: a close that hangs costs REAL time
 * while the stepped clock the phases are measured on does not move, so a case
 * driving the termination phase would see the close phase priced at zero. The
 * spend is charged when `close()` is CALLED, which is after `BoundedCleanup` has
 * read its own start instant and before it races anything — exactly where a
 * close that ran out its budget leaves the clock.
 */
export function applicationSpendingItsCloseBudget(
  clock: SteppedClock,
  spendMs: number,
  processId: number,
): ClosableApplication {
  return {
    close: () => {
      clock.advance(spendMs);
      return new Promise<void>(() => undefined);
    },
    processId: () => processId,
  };
}

/**
 * A terminator that records rather than signals — killing for real would take
 * this runner with it — and answers liveness however the case needs.
 */
export function terminatorSpy(
  delivers: boolean,
  running = true,
): ProcessTerminator & { readonly killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    isRunning: () => running,
    terminate: (processId: number) => {
      killed.push(processId);
      return delivers;
    },
  };
}

/**
 * A terminator that refuses its first `refusals` kills against a tree that survives them.
 *
 * The state no platform can be asked for on demand, and the only one the retry
 * exists for: `taskkill` spawns, exits non-zero, and the Electron it was aimed
 * at is still there — which is why `terminateProcessTree` reports delivery and
 * survival as two answers rather than one. `isRunning` answers `true`
 * throughout, because that is what a refused kill MEANS; the case that needs a
 * tree which never dies leaves the refusals unbounded through `terminatorSpy`.
 */
export function terminatorRefusingThenDelivering(
  refusals: number,
): ProcessTerminator & { readonly killed: number[] } {
  const killed: number[] = [];
  let refusalsRemaining = refusals;
  return {
    killed,
    isRunning: () => true,
    terminate: (processId: number) => {
      killed.push(processId);
      if (refusalsRemaining > 0) {
        refusalsRemaining -= 1;
        return false;
      }
      return true;
    },
  };
}

/** The directory a spy profile claims, so a message that names one can be checked. */
export const TEST_PROFILE_DIRECTORY = "/tmp/ai-sidekicks-console-spy";

/**
 * A profile that records the ATTEMPT rather than touching a disk — and refuses
 * it when the case is about a directory that will not go. Recording the attempt
 * rather than the success is what lets a case assert both halves: that the
 * removal was tried at all, and what came of it.
 */
export function profileSpy(
  refuseWith?: Error,
): LaunchProfile & { readonly removalAttempts: string[] } {
  const removalAttempts: string[] = [];
  return {
    directory: TEST_PROFILE_DIRECTORY,
    removalAttempts,
    remove: () => {
      removalAttempts.push(TEST_PROFILE_DIRECTORY);
      if (refuseWith !== undefined) {
        throw refuseWith;
      }
    },
  };
}

/** An application whose close rejects, with a pid the case decides the fate of. */
export function applicationWhoseCloseRejects(rejection: Error): ClosableApplication {
  return { close: () => Promise.reject(rejection), processId: () => 4242 };
}
