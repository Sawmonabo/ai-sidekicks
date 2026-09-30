// Closes a launched console within the cleanup ceiling and removes its private profile.
//
// The bound is the registered `console-launch-cleanup` ceiling on both the launch-failure path and
// the success path. A bound drawn from what the launch deadline has left would be near zero on the
// success path, where the caller closes long after the launch, and would SIGKILL a healthy
// application.
//
// When the bound is reached the process tree is SIGKILLed and the outcome is returned, not thrown:
// cleanup is never the first failure, so the caller attaches the verdict to the error it already
// carries. A profile that could not be removed travels on the outcome too;
// `cleanup-disposition.ts` decides what a caller is told.

import { DISPOSAL_ATTEMPTS, TERMINATION_GRACE_MS } from "./managed-electron-child.js";
import {
  type CleanupClock,
  type CleanupOutcome,
  type ClosableApplication,
  type ProcessTerminator,
} from "./cleanup-contract.js";
import { CLEANUP_BUDGET_MS } from "./launch-budgets.js";
import { type LaunchProfile, removeLaunchProfile } from "./launch-profile.js";

/**
 * Closes an application within the cleanup budget, or kills it.
 *
 * The application, terminator and profile are constructor arguments so a test can drive a close
 * that never settles or a removal that fails. The budget and termination wait are arguments so a
 * test can exhaust them without waiting out the registered ceiling.
 */
export class BoundedCleanup {
  readonly #application: ClosableApplication;
  readonly #terminator: ProcessTerminator;
  readonly #profile: LaunchProfile;
  readonly #budgetMs: number;
  readonly #terminationWaitMs: number;
  readonly #readClock: CleanupClock;

  constructor(
    application: ClosableApplication,
    terminator: ProcessTerminator,
    profile: LaunchProfile,
    budgetMs: number = CLEANUP_BUDGET_MS,
    terminationWaitMs: number = TERMINATION_GRACE_MS,
    readClock: CleanupClock = Date.now,
  ) {
    this.#application = application;
    this.#terminator = terminator;
    this.#profile = profile;
    this.#budgetMs = budgetMs;
    this.#terminationWaitMs = terminationWaitMs;
    this.#readClock = readClock;
  }

  /**
   * Closes the application, then removes the profile, and reports both.
   *
   * The removal is not in a `finally` around the close, which would let a failed removal displace
   * the settlement the close reached. The profile comes off disk whatever the close settled.
   */
  async close(): Promise<CleanupOutcome> {
    const settled = await this.#closeOrTerminate();
    const profileRemovalFailure = removeLaunchProfile(this.#profile);
    return profileRemovalFailure === undefined ? settled : { ...settled, profileRemovalFailure };
  }

  /** Races the close against the bound and SIGKILLs the process tree if the bound wins. */
  async #closeOrTerminate(): Promise<CleanupOutcome> {
    const startedAt = this.#readClock();
    const budgetMs = this.#budgetMs;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<"expired">((resolveExpiry) => {
      timeoutHandle = setTimeout(() => {
        resolveExpiry("expired");
      }, budgetMs);
    });
    const closing = this.#application.close().then(() => "closed" as const);
    // Killing the process rejects an abandoned close, and unhandled that would fail the tier on
    // the wrong error. `Promise.race` attaches handlers to both promises, so the loser stays
    // handled.
    let raced: "closed" | "expired" | "rejected";
    let closeRejection: unknown;
    try {
      raced = await Promise.race([closing, budgetExpired]);
    } catch (error: unknown) {
      // A rejected close has stopped trying, but it may have left the process running, so it is
      // not reported as plain `closed`.
      closeRejection = error;
      raced = "rejected";
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (raced === "closed") {
      return { settlement: "closed", waitedMs: this.#readClock() - startedAt, budgetMs };
    }
    const processId = this.#application.processId();
    if (raced === "rejected") {
      // Nothing to kill when the handle or the process is gone, but the close still failed: the
      // rejection travels on the outcome. The probe is charged to what the close has left.
      if (
        processId === undefined ||
        !this.#terminator.isRunning(processId, this.#budgetLeftSince(startedAt))
      ) {
        return {
          settlement: "closed-after-rejection",
          waitedMs: this.#readClock() - startedAt,
          budgetMs,
          closeRejection,
          processId,
        };
      }
      return {
        settlement: (await this.#terminateUntilGone(processId)) ? "terminated" : "unterminable",
        waitedMs: this.#readClock() - startedAt,
        budgetMs,
        closeRejection,
        processId,
      };
    }
    // The budget expired with the close outstanding, so the process is presumed alive and the
    // probe is skipped: a SIGKILL that has not been reaped yet would make a live target look gone.
    const terminated = processId !== undefined && (await this.#terminateUntilGone(processId));
    return {
      settlement: terminated ? "terminated" : "unterminable",
      waitedMs: this.#readClock() - startedAt,
      budgetMs,
      processId,
    };
  }

  /**
   * Signals the tree and asks again while the platform refuses, until it is gone or time is out.
   *
   * A terminator that reports delivery ends the loop at once, so an ordinary cleanup is one call.
   * After a refusal the tree itself is checked rather than the platform's exit status, since a
   * tree that is gone is gone whatever `taskkill` said. The close is idempotent, so a caller cannot
   * ask again by closing again; the retry belongs inside this pass, with `DISPOSAL_ATTEMPTS`
   * shared with the settle-time child disposal.
   *
   * The loop has its own deadline: the same registered figure the close was held to, restarted at
   * the first attempt. The close's remaining budget is already zero on the path this loop exists
   * for. Every reader inside the loop, the pause included, is charged to that deadline. Charged to
   * the close's origin, each pause would be zero-length and the attempts would run back to back.
   * `CLEANUP_PHASES` in `launch-deadline.ts` counts this restart. Giving up an ask never gives up
   * the profile removal in `close()`.
   */
  async #terminateUntilGone(processId: number): Promise<boolean> {
    const terminationStartedAt = this.#readClock();
    for (let attempt = 0; attempt < DISPOSAL_ATTEMPTS; attempt += 1) {
      const budgetBeforeAttempt = this.#budgetLeftSince(terminationStartedAt);
      if (budgetBeforeAttempt <= 0) {
        return false;
      }
      if (this.#terminator.terminate(processId, budgetBeforeAttempt)) {
        return true;
      }
      await this.#whenTerminationHasHadTime(terminationStartedAt);
      // The liveness read is not behind the budget guard: it decides the verdict, and skipping it
      // would report `unterminable` over a tree a refused-then-landed kill already took down. Its
      // budget is read afresh; at zero it spawns nothing and answers "still there".
      if (!this.#terminator.isRunning(processId, this.#budgetLeftSince(terminationStartedAt))) {
        return true;
      }
    }
    return false;
  }

  /**
   * What a deadline that began at `origin` has left of the budget, never negative.
   *
   * The close is charged from when it started; every reader inside the termination loop is charged
   * from that loop's first attempt, because the close's own deadline is already spent there.
   */
  #budgetLeftSince(origin: number): number {
    return Math.max(0, this.#budgetMs - (this.#readClock() - origin));
  }

  /**
   * The bounded pause a refused attempt spends before the tree is asked about again.
   *
   * The shorter of the grace interval and what the termination phase has left. It may reach zero
   * once that phase's budget is spent: a zero-length timer still yields a macrotask, so the
   * liveness recheck is a second reading and not the same one.
   */
  async #whenTerminationHasHadTime(terminationStartedAt: number): Promise<void> {
    const waitMs = Math.min(this.#terminationWaitMs, this.#budgetLeftSince(terminationStartedAt));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
}
