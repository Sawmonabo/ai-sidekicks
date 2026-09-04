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

import { processExists, terminateProcessTree } from "../helpers/process-tree.js";
import { CLEANUP_BUDGET_MS } from "./launch-budgets.js";
import { type LaunchDeadline } from "./launch-deadline.js";

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
 * Raised when cleanup may have left something behind, or failed outright.
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
 * The error a caller must be shown, or `undefined` when nothing was left behind.
 *
 * A function rather than a conditional at the call site so the rule is stated
 * once and can be tested without launching Electron, which is the only way to
 * reach these settlements for real. Two settlements raise, and they are the two
 * a later launch can feel: `unterminable`, where a process nothing could kill
 * may still be holding its profile, and `closed-after-rejection`, where the
 * close failed outright and the caller would otherwise never hear the rejection.
 *
 * `terminated` is deliberately NOT one of them. It says the tree was SIGKILLed,
 * which `withCleanupOutcome` reports in the same breath as "later launches are
 * unaffected" — and a verdict cannot both say that and fail a tier over it. What
 * failing it would actually catch is a healthy shutdown that ran long: the
 * endurance tier closes minutes after its launch deadline is spent, so the
 * applied bound is the reserve alone, and an Electron flushing a session store
 * on a loaded two-core runner can lose that race with every assertion passed and
 * nothing leaked. So it is a breadcrumb the harness prints, not a red check.
 */
export function cleanupFailure(outcome: CleanupOutcome): CleanupFailedError | undefined {
  return outcome.settlement === "unterminable" || outcome.settlement === "closed-after-rejection"
    ? new CleanupFailedError(outcome)
    : undefined;
}
