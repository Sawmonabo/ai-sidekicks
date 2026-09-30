// The stand-ins the cleanup suites drive, and why each is a stand-in: an application whose close
// never settles, a terminator that answers however a case needs, and a profile that records a
// removal rather than touching a disk.
//
// Each is unreachable through the real collaborator, which is why `BoundedCleanup` takes them as
// constructor arguments. No fixture makes a browser process refuse to close on demand, no
// `rmSync` over a directory this process owns fails on a POSIX runner, and no platform can be
// asked to refuse a kill. The terminator seam is more than a convenience: these cases run inside
// the runner, and a terminator that really killed something would deliver to a whole process
// group, the launched tree only because playwright-core spawns detached, and somebody else's for
// any other pid it is handed.
//
// It is a `.test-support` module, so its only legitimate dependents are the suites beside it,
// which `test-support-has-no-shipping-reader` in `.dependency-cruiser.mjs` enforces.

import { type ClosableApplication, type ProcessTerminator } from "./cleanup-contract.js";
import { type LaunchProfile } from "./launch-profile.js";

/** A close bound short enough that exhausting it costs the suite nothing. */
export const TEST_BUDGET_MS = 120;

/**
 * What each refused kill is given to leave nothing running, in these cases.
 *
 * Injected for `TEST_BUDGET_MS`'s reason: the retry spends this in full on every refusal, and
 * the registered figure is seconds, so a case exhausting the attempt bound cannot afford three.
 */
export const TEST_TERMINATION_WAIT_MS = 5;

/**
 * A grace long enough to observe, and short enough that every attempt gets one.
 *
 * Below the termination phase's whole budget divided by the attempt bound, so a pause never
 * exhausts the phase and the loop really does ask again; `TEST_OVERLONG_TERMINATION_WAIT_MS` is
 * deliberately larger than the budget and truncates to one pause, a different claim. Above the
 * millisecond a loop that does not pause takes to reach the bound, so the two shapes are
 * separated by a state and not by a threshold.
 */
export const TEST_SPACED_TERMINATION_WAIT_MS = 30;

/**
 * A grace interval deliberately longer than the whole close budget above.
 *
 * It separates a retry charged to that budget from one added after it: at this length three
 * added intervals dwarf the budget, so the shapes are hundreds of milliseconds apart rather than
 * tens, which makes the claim an assertion and not a race against a loaded runner.
 */
export const TEST_OVERLONG_TERMINATION_WAIT_MS = 500;

/**
 * A clock a case advances by hand, so a probe can "spend" its ceiling for free.
 *
 * A class rather than a closure because `read` is handed to `BoundedCleanup` as its clock seam
 * while `advance` stays the case's, and a pair of closures over a shared `let` would be
 * module-level mutable state.
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
 * `spendPerProbe` is what each reading costs the clock, which lets a case make a host query
 * "spend its ceiling" without waiting five real seconds.
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
 * An application whose close never settles and has already spent `spendMs`.
 *
 * `applicationThatNeverCloses` cannot produce this against an injected clock: a hanging close
 * costs real time while the stepped clock does not move, so a case driving the termination phase
 * would see the close phase priced at zero. The spend is charged when `close()` is called, after
 * `BoundedCleanup` has read its start instant and before it races anything, exactly where a
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
 * The retry's state: `taskkill` spawns, exits non-zero, and the Electron it was aimed at is
 * still there, which is why `terminateProcessTree` reports delivery and survival as two answers.
 * `isRunning` answers `true` throughout, because that is what a refused kill means; a tree that
 * never dies uses `terminatorSpy` with unbounded refusals.
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

/**
 * A terminator whose refusal clears on its own, `clearsAfterMs` after the first ask.
 *
 * The shape `terminatorRefusingThenDelivering` cannot express, and the one the retry's pause
 * exists for: a platform that refuses because something is still winding down (a `taskkill`
 * racing a process that is already exiting) and takes the next ask a moment later. Counting
 * refusals cannot tell those apart, since a loop that never pauses and one that pauses both
 * reach the bound, the latter after the tree is gone. The window opens at the first ask rather
 * than at construction, so it measures the spacing of the retries and not the length of the close.
 */
export function terminatorRefusingUntil(
  clearsAfterMs: number,
): ProcessTerminator & { readonly killed: number[] } {
  const killed: number[] = [];
  let clearsAt: number | undefined;
  return {
    killed,
    isRunning: () => true,
    terminate: (processId: number) => {
      killed.push(processId);
      clearsAt ??= Date.now() + clearsAfterMs;
      return Date.now() >= clearsAt;
    },
  };
}

/** The directory a spy profile claims, so a message that names one can be checked. */
export const TEST_PROFILE_DIRECTORY = "/tmp/ai-sidekicks-console-spy";

/**
 * A profile that records the attempt rather than touching a disk, and refuses it when the case
 * is about a directory that will not go. Recording the attempt rather than the success lets a
 * case assert both halves: that the removal was tried, and what came of it.
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
