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
// WHY THE BOUND IS A FLOOR AND NOT SIMPLY WHAT THE DEADLINE HAS LEFT
//
// `close()` is reached on two paths that look alike and are not. On the failure
// path it runs inside the launch, where the deadline is the right authority and
// its remaining time is exactly the cleanup slice. On the SUCCESS path the caller
// closes when its test is done — for the endurance tier, minutes later — and by
// then the launch deadline is long spent. A bound drawn from the deadline alone
// would be 1 ms there and would SIGKILL a perfectly healthy application on its
// way out. So the bound is `max(what the deadline has left, the reserved slice)`:
// the deadline can only ever GRANT more time than the reserve, never less.
//
// WHAT HAPPENS WHEN THE BOUND IS REACHED
//
// The process tree is SIGKILLed, and the outcome is reported rather than thrown.
// Cleanup is never the interesting failure — something else already went wrong to
// get here — so it returns a verdict the caller attaches to the error it was
// already carrying, in the shape `FrameWitness` uses for the same reason.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { CLEANUP_BUDGET_MS, type LaunchDeadline } from "./launch-deadline.js";

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
 * signalling anything: a spy is an object literal, and a terminator that really
 * killed something would take the test runner's own process tree with it on the
 * negative-pid arm below.
 */
export interface ProcessTerminator {
  /** Kill the tree led by `pid`. Returns whether a signal was delivered. */
  readonly terminate: (pid: number) => boolean;
  /**
   * Whether that process is still alive, asked without signalling it.
   *
   * On the same seam as `terminate` rather than a fourth constructor argument,
   * because the two are one subject: `terminationSucceeded` already decides a
   * kill by asking this question, and a cleanup that must decide whether a
   * FAILED close left anything running asks exactly the same one.
   */
  readonly isRunning: (pid: number) => boolean;
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
   * The bound this close was actually held to, in milliseconds.
   *
   * Reported rather than assumed to be `CLEANUP_BUDGET_MS`, because it usually
   * is not. The applied bound is `max(what the deadline has left, the reserve)`,
   * and a launch that failed EARLY leaves most of the deadline unspent — so a
   * readiness failure two seconds in gives cleanup nearly 55 000 ms. A message
   * that named the reserve there would claim a process failed to close within
   * ten seconds when it had been given five times that, which is a diagnostic
   * that misdescribes the very measurement it is reporting.
   */
  readonly budgetMs: number;
  /**
   * The process the settlement is about, when one was still addressable.
   *
   * Carried so a failure can NAME it: an operator told only that termination was
   * refused has nothing to look for in `ps`.
   */
  readonly processId?: number | undefined;
}

/**
 * SIGKILL an Electron process tree, on the shape both neighbours already use.
 *
 * The negative-pid form is only safe under one condition and is catastrophic
 * without it; the arm below states the measurement that establishes it.
 *
 * The Windows arm is `taskkill /pid N /T /F`, which is what playwright-core
 * itself runs for this process and what `test/helpers/electron-probe.ts` runs for
 * the smoke test's tree. Windows has no process group to signal and its
 * "signals" are `TerminateProcess` calls that are never forwarded, so killing the
 * leader alone would orphan the browser.
 *
 * Both arms decide success through `terminationSucceeded`, so neither reports a
 * kill it did not perform.
 */
/**
 * Whether a termination attempt left the process actually gone.
 *
 * Two ways to succeed, and the second is why this is a function rather than a
 * boolean at each call site. A signal that was delivered is a success. A signal
 * that was NOT is still a success if there is nothing left to kill — which is
 * the ordinary outcome when a process exited between the close timing out and
 * the kill being issued.
 *
 * Splitting the probe out as an argument is what makes both arms testable at
 * all: the real one signals a real process, so a test exercising it would kill
 * something, and on the POSIX arm that something is this test runner's own
 * process group.
 */
export function terminationSucceeded(
  signalDelivered: boolean,
  processStillExists: () => boolean,
): boolean {
  return signalDelivered || !processStillExists();
}

/**
 * Whether a pid names a live process, without signalling it.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing —
 * on Windows too, where Node maps it onto a handle open. `EPERM` means the
 * process is there and out of reach, which for this question is "still running":
 * reporting it gone would be the same false success this probe exists to catch.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const ELECTRON_PROCESS_TERMINATOR: ProcessTerminator = {
  isRunning: (pid: number): boolean => processExists(pid),
  terminate: (pid: number): boolean => {
    const stillExists = (): boolean => processExists(pid);
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      // `error` alone is not enough, and treating it as enough was a false
      // success: a taskkill that SPAWNS and then exits non-zero — termination
      // denied, most of all — leaves `error` undefined while Electron keeps
      // running, and the launch would report a tree it had killed. The exit code
      // is a separate field of the `spawnSync` result precisely because it is a
      // separate question.
      const delivered = result.error === undefined && result.status === 0;
      // A non-zero exit is not automatically a failure either: a tree already
      // gone is one of the things taskkill refuses. Which one it was is asked of
      // the OS rather than read out of taskkill's message, because that message
      // is localised and this must not depend on the runner's display language.
      return terminationSucceeded(delivered, stillExists);
    }
    // MEASURED, NOT ASSUMED: `playwright-core` spawns with
    // `detached: process.platform !== "win32"` (`lib/coreBundle.js`), so on POSIX
    // the launched Electron LEADS its own process group and `-pid` reaches the
    // browser, its zygote, and every renderer at once. An attached child would
    // instead share this runner's group, and the same call would SIGKILL vitest
    // itself — so the fallback below is to the group leader alone, never a
    // widening.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
        return true;
      } catch {
        // Group already reaped, or this pid does not lead one after all.
      }
    }
    // Both throws land here, and ESRCH is the commonest reason: the process was
    // already gone. Reporting that as a failed termination would tell a reader an
    // Electron may still be holding a profile when nothing is — the same
    // misdescription as the Windows arm, in the opposite direction.
    return terminationSucceeded(false, stillExists);
  },
};

/**
 * Closes an application within the deadline's cleanup slice, or kills it.
 *
 * A class for the reason its two collaborators are constructor arguments: the
 * application and the terminator are both seams, and the one behaviour worth
 * checking — a close that never settles — is unreachable through the real ones.
 */
export class BoundedCleanup {
  readonly #application: ClosableApplication;
  readonly #terminator: ProcessTerminator;
  readonly #deadline: LaunchDeadline;
  readonly #reservedMs: number;

  constructor(
    application: ClosableApplication,
    terminator: ProcessTerminator,
    deadline: LaunchDeadline,
    reservedMs: number = CLEANUP_BUDGET_MS,
  ) {
    this.#application = application;
    this.#terminator = terminator;
    this.#deadline = deadline;
    this.#reservedMs = reservedMs;
  }

  async close(): Promise<CleanupOutcome> {
    const startedAt = Date.now();
    const budgetMs = Math.max(this.#deadline.remainingMs(), this.#reservedMs);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<"expired">((resolveExpiry) => {
      timeoutHandle = setTimeout(() => {
        resolveExpiry("expired");
      }, budgetMs);
    });
    const closing = this.#application.close().then(() => "closed" as const);
    // An ABANDONED close must not take the process down. When the budget wins it
    // is still outstanding, and killing the process underneath it is precisely
    // what makes it reject — with no handler attached unless one is put here.
    // Attaching does not remove it from the race, so a close that fails FAST
    // still settles the race rather than waiting out the budget.
    closing.catch(() => undefined);
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

/**
 * Re-word a failure whose cleanup ALSO went wrong, without losing either.
 *
 * Cleanup is never the interesting failure — something else went wrong first to
 * reach it — so the original stays as `cause` and this only adds what the reader
 * could not otherwise know: that a process may still be running. Silent on a
 * clean close, because a sentence about cleanup on every failure would train a
 * reader to skip the one that matters.
 */
export function withCleanupOutcome(error: unknown, outcome: CleanupOutcome | undefined): unknown {
  if (outcome === undefined || outcome.settlement === "closed") {
    return error;
  }
  const rejectionNote =
    outcome.closeRejection instanceof Error
      ? ` (close rejected: ${outcome.closeRejection.message})`
      : "";
  if (outcome.settlement === "closed-after-rejection") {
    return new Error(
      `a launch failed, and closing the Electron process then failed too${rejectionNote} — though the ` +
        `process did exit, so nothing was left running; the failure that started this is the cause below`,
      { cause: error },
    );
  }
  const consequence =
    outcome.settlement === "terminated"
      ? "so its process tree was SIGKILLed; later launches are unaffected"
      : "and could not be terminated either, so it may still be running and holding its profile — " +
        "a later launch in the same job losing `requestSingleInstanceLock()` starts here";
  return new Error(
    `a launch failed, and the Electron process then did not close within the ${String(outcome.budgetMs)} ms ` +
      "it was given " +
      `(waited ${String(outcome.waitedMs)} ms)${rejectionNote} ${consequence}; the failure that started this is the cause below`,
    { cause: error },
  );
}

/**
 * Raised when a launch's cleanup did not end in a clean close.
 *
 * Thrown rather than logged, which is the whole point. A `console.error` is not a
 * failure to vitest, so a tier whose assertions passed reported success while
 * leaving an Electron alive — consuming the runner and, because every Playwright
 * tier shares one harness, interfering with the launches after it. The one
 * outcome a test cannot be allowed to ignore is the one it cannot see.
 *
 * Names the settlement AND the process id: an operator told only that termination
 * was refused has nothing to look for.
 */
export class CleanupFailedError extends Error {
  readonly settlement: CleanupSettlement;
  readonly processId: number | undefined;

  constructor(outcome: CleanupOutcome) {
    const target =
      outcome.processId === undefined
        ? "an unidentified process"
        : `pid ${String(outcome.processId)}`;
    super(
      `the launched Electron did not close cleanly: ${outcome.settlement} for ${target} after ` +
        `${String(outcome.waitedMs)} ms of the ${String(outcome.budgetMs)} ms it was given` +
        (outcome.settlement === "unterminable"
          ? " — it may still be running and holding its profile, and a later launch in the same job " +
            "losing `requestSingleInstanceLock()` starts here"
          : ""),
      outcome.closeRejection === undefined ? undefined : { cause: outcome.closeRejection },
    );
    this.name = "CleanupFailedError";
    this.settlement = outcome.settlement;
    this.processId = outcome.processId;
  }
}

/**
 * The error a caller must be shown, or `undefined` when cleanup was clean.
 *
 * A function rather than a conditional at the call site so the rule — every
 * settlement but `closed` is a failure — is stated once and can be tested without
 * launching Electron, which is the only way to reach these settlements for real.
 */
export function cleanupFailure(outcome: CleanupOutcome): CleanupFailedError | undefined {
  return outcome.settlement === "closed" ? undefined : new CleanupFailedError(outcome);
}
