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
// already carrying, in the shape `FrameWitness` uses for the same reason.
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

import { processExists, terminateProcessTree } from "../helpers/process-tree.js";
import { CLEANUP_BUDGET_MS } from "./launch-budgets.js";
import {
  type LaunchProfile,
  type ProfileRemovalFailure,
  removeLaunchProfile,
} from "./launch-profile.js";

/**
 * The launched application, reduced to what cleanup needs of it.
 *
 * An interface rather than Playwright's `ElectronApplication` so a stub whose
 * `close()` never settles is one object literal. That case cannot be produced
 * with a real Electron — no fixture makes a browser process refuse to close on
 * demand — which is exactly why it was the case nothing checked.
 */
export interface ClosableApplication {
  readonly close: () => Promise<void>;
  /** The launched process, or `undefined` once it has exited or was never spawned. */
  readonly processId: () => number | undefined;
}

/**
 * Force-termination, as a seam.
 *
 * A constructor argument so a test can assert the SIGKILL happened without
 * signalling anything: a spy is an object literal, and these cases run INSIDE
 * the runner, where a terminator that really killed something would deliver to
 * a whole process group — the launched tree only because playwright-core spawns
 * detached, and somebody else's group for any other pid it is handed.
 */
export interface ProcessTerminator {
  /** Kill the tree led by `processId`. Returns whether a signal was delivered. */
  readonly terminate: (processId: number) => boolean;
  /**
   * Whether that process is still alive, asked without signalling it.
   *
   * On the same seam as `terminate` rather than a fourth constructor argument,
   * because the two are one subject: `terminationSucceeded` already decides a
   * kill by asking this question, and a cleanup that must decide whether a
   * FAILED close left anything running asks exactly the same one.
   */
  readonly isRunning: (processId: number) => boolean;
}

/**
 * How the close settled.
 *
 * `unterminable` is deliberately distinct from `terminated` rather than folded
 * into it: it means a process may still be running and holding a profile, which
 * is the one cleanup outcome that can affect a LATER launch, and a reader who
 * cannot tell it from a successful kill has lost the only actionable half.
 *
 * `closed-after-rejection` is distinct from `closed` for the mirror reason. The
 * close failed and the process is nonetheless gone, so nothing leaked and no kill
 * was needed — but a caller told plain `closed` would have no way to surface the
 * rejection, and this cleanup used to discard it silently.
 */
export type CleanupSettlement = "closed" | "closed-after-rejection" | "terminated" | "unterminable";

export interface CleanupOutcome {
  readonly settlement: CleanupSettlement;
  /**
   * Why `application.close()` rejected, when it did.
   *
   * Present on every settlement reached through a rejection and absent
   * otherwise, so a caller can attach it rather than lose it. It used to be
   * caught and dropped on the floor, which is how a close that failed outright
   * could be reported as one that succeeded.
   */
  readonly closeRejection?: unknown;
  /** Wall milliseconds spent closing, measured driver-side. */
  readonly waitedMs: number;
  /**
   * The bound this close was held to, in milliseconds.
   *
   * `CLEANUP_BUDGET_MS` for every launched console, and reported rather than
   * re-derived by its readers so the sentence a reader sees and the race that
   * produced it cannot disagree: the cases that exercise a hung close supply a
   * bound short enough to exhaust, and a message naming the constant there would
   * misdescribe the very measurement it is reporting.
   */
  readonly budgetMs: number;
  /**
   * The process the settlement is about, when one was still addressable.
   *
   * Carried so a failure can NAME it: an operator told only that termination was
   * refused has nothing to look for in `ps`.
   */
  readonly processId?: number | undefined;
  /**
   * The launch profile still on disk, when removing it failed.
   *
   * On the verdict rather than raised where it happens, and independent of the
   * settlement rather than folded into it: a close can go perfectly while the
   * removal fails, and the two facts are separately actionable. Absent means the
   * directory is gone.
   */
  readonly profileRemovalFailure?: ProfileRemovalFailure | undefined;
}

/**
 * The terminator every real launch uses, over the one shared implementation.
 *
 * A thin binding rather than a body: the platform facts live in
 * `test/helpers/process-tree.ts`, shared with the Tier-1 smoke probe, because
 * two copies of them had already disagreed about whether `taskkill`'s exit
 * status counts. `BoundedCleanup` still takes the seam as a constructor
 * argument — a terminator that really killed something would signal a whole
 * process group from inside the runner, and a test must signal nothing.
 */
export const ELECTRON_PROCESS_TERMINATOR: ProcessTerminator = {
  isRunning: (processId: number): boolean => processExists(processId),
  terminate: (processId: number): boolean => terminateProcessTree(processId),
};

/**
 * Closes an application within the cleanup budget, or kills it.
 *
 * A class for the reason its three collaborators are constructor arguments: the
 * application, the terminator, and the profile are all seams, and the behaviours
 * worth checking — a close that never settles, a removal that will not — are
 * unreachable through the real ones. The bound is the fourth argument for the
 * same reason and no other: a case that has to EXHAUST it cannot afford to wait
 * the registered ten seconds out.
 */
export class BoundedCleanup {
  readonly #application: ClosableApplication;
  readonly #terminator: ProcessTerminator;
  readonly #profile: LaunchProfile;
  readonly #budgetMs: number;

  constructor(
    application: ClosableApplication,
    terminator: ProcessTerminator,
    profile: LaunchProfile,
    budgetMs: number = CLEANUP_BUDGET_MS,
  ) {
    this.#application = application;
    this.#terminator = terminator;
    this.#profile = profile;
    this.#budgetMs = budgetMs;
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
    const startedAt = Date.now();
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
      return { settlement: "closed", waitedMs: Date.now() - startedAt, budgetMs };
    }
    const processId = this.#application.processId();
    if (raced === "rejected") {
      // Nothing to kill: either the handle is gone or the process is. The close
      // still failed, so this is not plain `closed` and the rejection travels
      // with it — the launch-failure path attaches it, and the success path
      // refuses to report a green tier over it.
      if (processId === undefined || !this.#terminator.isRunning(processId)) {
        return {
          settlement: "closed-after-rejection",
          waitedMs: Date.now() - startedAt,
          budgetMs,
          closeRejection,
          processId,
        };
      }
      return {
        settlement: this.#terminator.terminate(processId) ? "terminated" : "unterminable",
        waitedMs: Date.now() - startedAt,
        budgetMs,
        closeRejection,
        processId,
      };
    }
    // The budget expired with the close still outstanding, so the process is
    // presumed alive and the probe is skipped: a SIGKILL has not been reaped yet
    // at this instant, and asking would only make a live target look gone.
    const terminated = processId !== undefined && this.#terminator.terminate(processId);
    return {
      settlement: terminated ? "terminated" : "unterminable",
      waitedMs: Date.now() - startedAt,
      budgetMs,
      processId,
    };
  }
}
