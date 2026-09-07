// Closing a launched console, bounded — because `close()` can hang too.
//
// `launchConsole()`'s failure path closes the application before it rethrows, and
// that close used to be awaited with no bound at all. An Electron wedged rather
// than merely slow therefore consumed whatever the tier had left and vitest's
// generic timeout won anyway: no diagnostic, no breadcrumb, and a temporary
// profile left on disk for the next launch to trip over. Bounding every phase of
// the launch and then leaving the last one unbounded is not a fix; it is the same
// undiagnosable kill one line further down.
//
// WHY THE BOUND IS THE REGISTERED CEILING AND NOT WHAT THE DEADLINE HAS LEFT
//
// `close()` is reached on two paths that look alike and are not. On the failure
// path it runs inside the launch, with most of the deadline still unspent; on the
// SUCCESS path the caller closes when its test is done — for the endurance tier,
// minutes later — and by then the launch deadline is long gone. A bound drawn
// from the deadline alone would be 1 ms there and would SIGKILL a perfectly
// healthy application on its way out, and `max(what the deadline has left, the
// reserved slice)` fixed that by granting the OTHER path almost the whole 55 000
// ms deadline instead: five times the bound `budget/budgets.json` declares
// enforced for `console-launch-cleanup`, in a registry that models every row as a
// ceiling. A budget audit that reads a constraint the harness does not apply is
// worse than no row at all.
//
// So the deadline is not consulted here. The applied bound is the registry's
// figure and the same one on both paths, which is strictly tighter than what it
// replaces — the launch still settles inside `LAUNCH_BUDGET_MS`, whose cleanup
// slice the readiness ladder reserves for exactly this and which is now spent as
// a ceiling rather than drawn down.
//
// WHAT HAPPENS WHEN THE BOUND IS REACHED
//
// The process tree is SIGKILLed, and the outcome is reported rather than thrown.
// Cleanup is never the interesting failure — something else already went wrong to
// get here — so it returns a verdict the caller attaches to the error it was
// already carrying, in the shape `FrameWitness` uses for the same reason. A kill
// the platform REFUSES is asked again inside that one pass, bounded by the same
// figure the settle-time child disposal uses — `#terminateUntilGone` has the
// reason it cannot be left to a second call.
//
// THE PROFILE IS PART OF THE VERDICT, NOT A STEP BESIDE IT
//
// Closing a launched console is not finished until its private profile is off
// disk, so the removal happens here and its failure travels on the outcome. It
// was a `try`/`catch` at the caller whose `catch` only logged, which meant a
// removal that failed on a Windows file lock left a passing tier green and the
// directory on disk for every launch after it to add to. What a caller is TOLD
// about any of this — including which outcomes raise — is
// `cleanup-disposition.ts`.

import { DISPOSAL_ATTEMPTS, TERMINATION_GRACE_MS } from "../helpers/managed-electron-child.js";
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
 * A class for the reason its three collaborators are constructor arguments: the
 * application, the terminator, and the profile are all seams, and the behaviours
 * worth checking — a close that never settles, a removal that will not — are
 * unreachable through the real ones. The bound is the fourth argument for the
 * same reason and no other: a case that has to EXHAUST it cannot afford to wait
 * the registered ten seconds out, and the fifth — how long a REFUSED kill is
 * given to leave nothing running — is the same argument for the same reason.
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
   * Close the application, then remove the profile, and report both.
   *
   * In that order and never in a `finally` around the close: either shape lets a
   * removal that failed displace the settlement the close reached, which is the
   * inversion `closeAfterBody` exists to stop one level up. The profile comes off
   * disk whatever the close settled — a directory left behind by a run that
   * crashed is what makes the NEXT run's disk-space failure look like a console
   * defect.
   */
  async close(): Promise<CleanupOutcome> {
    const settled = await this.#closeOrTerminate();
    const profileRemovalFailure = removeLaunchProfile(this.#profile);
    return profileRemovalFailure === undefined ? settled : { ...settled, profileRemovalFailure };
  }

  /** The race itself: close inside the bound, or SIGKILL what would not. */
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
    // An ABANDONED close must not take the process down. When the budget wins it
    // is still outstanding, and killing the process underneath it is precisely
    // what makes it reject; unhandled, that would fail the tier on something
    // other than the failure that started the cleanup. The race is what stops it
    // — `Promise.race` calls `then` on both promises, so the loser stays handled
    // for the rest of its life, and a close that fails FAST still settles the
    // race rather than waiting the budget out. A bare `.catch(() => undefined)`
    // used to sit here claiming to be that mechanism; it was a second handler on
    // an already-handled promise. The claim is made where it can fail instead,
    // in `architecture/bounded-cleanup.test.ts`.
    let raced: "closed" | "expired" | "rejected";
    let closeRejection: unknown;
    try {
      raced = await Promise.race([closing, budgetExpired]);
    } catch (error: unknown) {
      // A close that REJECTS has stopped trying. Whether it LEFT anything
      // running is a separate question, and it is the one that matters: this
      // used to answer "closed", skip termination, and discard the rejection, so
      // a tier could go green with an Electron still holding its profile.
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
      // Nothing to kill: either the handle is gone or the process is. The close
      // still failed, so this is not plain `closed` and the rejection travels
      // with it — the launch-failure path attaches it, and the success path
      // refuses to report a green tier over it.
      // Charged to what the CLOSE has left, which on this path is usually most
      // of it: a close that rejected fast has spent almost nothing, and the
      // probe still must not be able to outlive the budget it sits inside.
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
    // The budget expired with the close still outstanding, so the process is
    // presumed alive and the probe is skipped: a SIGKILL has not been reaped yet
    // at this instant, and asking would only make a live target look gone.
    const terminated = processId !== undefined && (await this.#terminateUntilGone(processId));
    return {
      settlement: terminated ? "terminated" : "unterminable",
      waitedMs: this.#readClock() - startedAt,
      budgetMs,
      processId,
    };
  }

  /**
   * Signal the tree, and ask again while the platform says it refused.
   *
   * ONE ASK WAS NOT ENOUGH, and the settle-time path is where that showed. A
   * refused kill is a real outcome rather than a hypothetical — a `taskkill` that
   * spawns, exits non-zero and leaves Electron running, which is why
   * `terminateProcessTree` reports delivery and survival as two answers — and the
   * close this cleanup performs is idempotent by a `closed` guard set BEFORE the
   * cleanup runs, so a caller that received `unterminable` could not ask again by
   * closing again. The retry therefore belongs inside the one pass, and the shape
   * is the settle-time child disposal's down to the constant: attempt, wait for
   * evidence, return the moment the tree is gone. `DISPOSAL_ATTEMPTS` is
   * imported from `managed-electron-child.ts`, which is where that bound lives
   * for every caller that spends it, rather than restated — two `3`s in two
   * files are two bounds that will disagree.
   *
   * THE DELIVERY REPORT SHORT-CIRCUITS AND THE EVIDENCE DECIDES. A terminator
   * that says it delivered is believed and the loop ends there, which is what
   * keeps every ordinary cleanup exactly one call long and unchanged by this. A
   * REFUSAL is what costs a wait, and after that wait the question is asked of the
   * process rather than of the platform's exit status: a tree that is gone is
   * gone, whatever `taskkill` said about it.
   *
   * THE WAITS ARE BOUNDED BY A BUDGET, NOT ADDED BESIDE ONE. They used to be
   * added: three grace intervals began once `application.close()` had already
   * spent its whole registered ceiling, so the all-refused path cost the ceiling
   * plus the intervals — past what `tierTimeoutFor` reserves for cleanup, which
   * meant vitest's own timeout fired first and took the `unterminable` verdict
   * and every diagnostic on it with it. That is the inversion this module's
   * header opens with, reintroduced one level in. A spawner's own deadline has to
   * fire before its enclosing budget, so the pause is DERIVED from what is left
   * of a budget rather than spent beside it — and from THIS phase's, which is the
   * correction the paragraph below states. The ATTEMPTS are unchanged: they are
   * the policy, and a verdict reached with no pause left is still the verdict a
   * reader came for, while a verdict vitest killed is not reached at all.
   *
   * AND THE PROBES ARE CHARGED TOO, WHICH THE PAUSE ALONE NEVER WAS. The pause is
   * the cheapest thing here. `terminate` and `isRunning` are both SYNCHRONOUS
   * host queries — a root start-stamp read and a whole process-table read, each
   * bounded only by `HOST_QUERY_TIMEOUT_MS` and each blocking this thread — so on
   * the path this loop exists for, a close that spent its ceiling and a platform
   * that refuses every kill, three attempts added roughly thirty seconds that
   * NOTHING was charged for, past what `tierTimeoutFor` reserves. Vitest fired
   * first and took the `unterminable` verdict with it.
   *
   * So the loop carries its OWN deadline, DERIVED rather than invented: the same
   * registered figure the close was held to, restarted at the first attempt. It
   * cannot be the close's REMAINING budget, which on that path is already zero —
   * refusing the first kill after a hung close would trade a bounded overrun for
   * a live Electron still holding its profile.
   *
   * AND EVERY READER INSIDE THE LOOP TAKES THAT DEADLINE, THE PAUSE INCLUDED.
   * The pause was the one that did not: it was charged to the close's origin,
   * which on this path is spent, so `min(grace, 0)` made every retry timer
   * zero-length and the three attempts ran back to back. A platform whose refusal
   * is TRANSIENT — the `taskkill` that spawns, exits non-zero, and takes the next
   * ask — was therefore asked three times inside a few milliseconds, reported
   * `unterminable`, and had its profile removed under an Electron that would have
   * died inside the grace it was never given. Two deadlines here are not two
   * budgets: they are one figure with two origins, and a reader inside the second
   * phase charged to the first phase's origin has no time by construction.
   *
   * WHICH MAKES THIS PHASE THE SECOND ONE THE TIER RESERVES FOR, and a restart
   * left unstated is a restart nothing waits for: the tier's slice held ONE such
   * figure, so this loop's whole deadline sat outside it and vitest could fire
   * before the `unterminable` verdict or the removal existed. `CLEANUP_PHASES`
   * in `launch-deadline.ts` is where that count lives, and
   * `architecture/cleanup-slice-derivation.test.ts` measures this class's own
   * end-to-end spend against it rather than trusting the two to agree. Giving up
   * an ask never gives up the removal: `close()` above removes the profile on
   * every settlement this returns into.
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
      // The liveness read is deliberately NOT behind that guard: it is the
      // evidence that decides this verdict, and skipping it would report
      // `unterminable` over a tree the refused-then-landed kill already took
      // down — a false alarm on the one settlement a later launch feels. Its
      // budget is read AFRESH rather than reused, because the attempt above may
      // have spent all of it — and at zero this reading spawns nothing and
      // answers "still there", which sends the loop back to the guard.
      if (!this.#terminator.isRunning(processId, this.#budgetLeftSince(terminationStartedAt))) {
        return true;
      }
    }
    return false;
  }

  /**
   * What a deadline that began at `origin` has left of the budget, never negative.
   *
   * ONE derivation for all three readers — the pause between attempts, the
   * budget each host query is charged against, and the liveness probe on the
   * rejected path — because the same subtraction written three times is three
   * things that drift. The origin differs because the deadlines do: the close is
   * charged from when it started, and every reader inside the termination loop —
   * the attempt's own budget, the pause after a refusal, and the liveness
   * recheck — from that loop's first attempt. A reader inside the loop charged to
   * the close's origin is charged to a deadline that is already spent on the one
   * path the loop exists for, which reads as zero and is not what any of them
   * mean.
   */
  #budgetLeftSince(origin: number): number {
    return Math.max(0, this.#budgetMs - (this.#readClock() - origin));
  }

  /**
   * The bounded pause a refused attempt spends before the tree is asked about again.
   *
   * The grace interval, or whatever the TERMINATION phase has left — whichever
   * is shorter, and the origin is the whole of it. Charged to the close instead,
   * every wait after a close that had already spent its ceiling was a zero-length
   * timer: the three attempts ran back to back inside one macrotask each, so a
   * platform that refuses a kill transiently was asked three times inside a few
   * milliseconds, answered `unterminable`, and had its profile removed under a
   * live Electron — while the refusal would have cleared inside
   * `TERMINATION_GRACE_MS`. The attempts are the policy and the pause is what
   * makes each one a genuinely later question, so it is charged to the phase that
   * reserved time for it.
   *
   * Still deliberately allowed to reach zero, once that phase's OWN budget is
   * spent: a zero-length timer yields the loop a macrotask, so the liveness
   * recheck is a second reading rather than the same one.
   */
  async #whenTerminationHasHadTime(terminationStartedAt: number): Promise<void> {
    const waitMs = Math.min(this.#terminationWaitMs, this.#budgetLeftSince(terminationStartedAt));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
}
