// What a caller is TOLD when a close did not go cleanly, and whose failure wins.
//
// `bounded-cleanup.ts` owns the race — which settlement a close reaches and
// whether the profile came off disk. This owns the disposition of that verdict:
// which outcomes a caller must be shown, how they are worded, and what happens
// when the test body failed too. The two were one module until the race grew the
// profile removal and pushed it past 400 lines, which is the split
// `architecture/bounded-cleanup.test.ts` and `architecture/cleanup-disposition.test.ts`
// had already made for the same reason.
//
// WHAT RAISES AND WHAT ONLY BREADCRUMBS
//
// Cleanup that went wrong used to be reported with `console.error` while the
// harness resolved anyway, and a log line is not a failure to vitest: a tier
// whose assertions passed reported success while leaving an Electron alive for
// every launch after it. So the outcomes a LATER launch can feel raise, and the
// one that cannot — a tree that was SIGKILLed and is therefore gone — is a
// breadcrumb. `cleanupFailure` is where that line is drawn, once.

import {
  type CleanupOutcome,
  type CleanupSettlement,
  type ClosableApplication,
} from "./bounded-cleanup.js";
import { type ProfileRemovalFailure } from "./launch-profile.js";

/**
 * The clause about a profile that outlived its launch, or nothing.
 *
 * One wording for both readers below, because they describe the same fact and a
 * second copy would drift. It says what a reader can act on — the path, and that
 * the next launch adds another — rather than only that a removal failed.
 */
function profileRemovalClause(failure: ProfileRemovalFailure | undefined): string | undefined {
  return failure === undefined
    ? undefined
    : `the launch profile at ${failure.directory} could not be removed ` +
        `(${String(failure.failure)}), so it is still on disk and every launch after it adds another`;
}

/** The clauses that apply, in reading order, with the ones that do not dropped. */
function clausesOf(...clauses: readonly (string | undefined)[]): readonly string[] {
  return clauses.filter((clause): clause is string => clause !== undefined);
}

/**
 * Put `clauses` above the failure that explains the run, or hand it back whole.
 *
 * One construction for both folds below, and the trailer is the point: whatever
 * cleanup adds, the error a reader came for is still the `cause` and is
 * announced as such.
 */
function withClauses(error: unknown, clauses: readonly string[]): unknown {
  return clauses.length === 0
    ? error
    : new Error(`${clauses.join("; ")}; the failure that started this is the cause below`, {
        cause: error,
      });
}

/**
 * Re-word a failure whose cleanup ALSO went wrong, without losing either.
 *
 * Cleanup is never the interesting failure — something else went wrong first to
 * reach it — so the original stays as `cause` and this only adds what the reader
 * could not otherwise know: that a process may still be running, or that a
 * profile is still on disk. Silent on a clean close that removed its profile,
 * because a sentence about cleanup on every failure would train a reader to skip
 * the one that matters.
 *
 * The sentence names no phase, deliberately: it is reached from the launch's own
 * failure path AND from `closeAfterBody`, where the failure kept is a test
 * body's assertion, and "a launch failed" would misdescribe that run.
 */
export function withCleanupOutcome(error: unknown, outcome: CleanupOutcome | undefined): unknown {
  if (outcome === undefined) {
    return error;
  }
  return withClauses(
    error,
    clausesOf(closeClause(outcome), profileRemovalClause(outcome.profileRemovalFailure)),
  );
}

/**
 * Fold a profile that outlived its launch into the failure that explains the run.
 *
 * The pre-launch arm's counterpart to `withCleanupOutcome`, and it exists because
 * that arm has no verdict to carry the removal on: a launch that threw before it
 * produced an application never reached the cleanup. Raising the removal there
 * instead would REPLACE a readiness failure with a sentence about a directory,
 * which is the inversion this module stops everywhere else.
 */
export function withProfileRemoval(
  error: unknown,
  failure: ProfileRemovalFailure | undefined,
): unknown {
  return withClauses(error, clausesOf(profileRemovalClause(failure)));
}

/**
 * Why the close rejected, in a reader's words, or `undefined` if it did not.
 *
 * The presence of a rejection is what separates the two ways a close can fail,
 * so it is asked once here and every wording below branches on the answer rather
 * than appending the same parenthetical to both.
 */
function closeRejectionReason(closeRejection: unknown): string | undefined {
  if (closeRejection === undefined) {
    return undefined;
  }
  return closeRejection instanceof Error ? closeRejection.message : String(closeRejection);
}

/** How the close itself is worded to a caller carrying its own failure. */
function closeClause(outcome: CleanupOutcome): string | undefined {
  if (outcome.settlement === "closed") {
    return undefined;
  }
  const rejectionReason = closeRejectionReason(outcome.closeRejection);
  if (outcome.settlement === "closed-after-rejection") {
    return (
      `closing the launched Electron failed` +
      `${rejectionReason === undefined ? "" : ` (close rejected: ${rejectionReason})`} — though the ` +
      `process did exit, so nothing was left running`
    );
  }
  const consequence =
    outcome.settlement === "terminated"
      ? "so its process tree was SIGKILLed; later launches are unaffected"
      : "and could not be terminated either, so it may still be running and holding its profile — " +
        "a later launch in the same job losing `requestSingleInstanceLock()` starts here";
  // TWO WAYS TO REACH A KILL, AND ONLY ONE OF THEM WAITED. `application.close()`
  // can reject at once while the process is still alive, and `BoundedCleanup`
  // then terminates without waiting the budget out — so the sentence below used
  // to report a few milliseconds of `waitedMs` beside a claim that ten seconds
  // had expired, which is the one thing a reader needs distinguished here: a
  // cleanup that timed out and a cleanup that failed outright have different
  // causes and different fixes.
  return rejectionReason === undefined
    ? `the launched Electron did not close within the ${String(outcome.budgetMs)} ms it was given ` +
        `(waited ${String(outcome.waitedMs)} ms) ${consequence}`
    : `closing the launched Electron rejected (${rejectionReason}) after ` +
        `${String(outcome.waitedMs)} ms, rather than reaching the ${String(outcome.budgetMs)} ms ` +
        `bound, ${consequence}`;
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
 * Names the settlement AND the process id, and the profile directory when that is
 * what went wrong: an operator told only that cleanup failed has nothing to look
 * for.
 */
export class CleanupFailedError extends Error {
  /**
   * The verdict this error was built from, carried whole.
   *
   * A caller folding this cleanup into a failure of its own needs the outcome,
   * not a re-derivation of it from the message — and two copied fields used to
   * be the only way through. `closeAfterBody` reads it and hands it straight to
   * `withCleanupOutcome`.
   */
  readonly outcome: CleanupOutcome;

  constructor(outcome: CleanupOutcome) {
    // The removal's error only becomes the cause where the close produced none:
    // a rejected close is the earlier and more explanatory of the two.
    const cause =
      outcome.closeRejection === undefined
        ? outcome.profileRemovalFailure?.failure
        : outcome.closeRejection;
    super(
      clausesOf(
        closeFailureClause(outcome),
        profileRemovalClause(outcome.profileRemovalFailure),
      ).join("; "),
      cause === undefined ? undefined : { cause },
    );
    this.name = "CleanupFailedError";
    this.outcome = outcome;
  }

  get settlement(): CleanupSettlement {
    return this.outcome.settlement;
  }

  get processId(): number | undefined {
    return this.outcome.processId;
  }
}

/** How the close itself is worded when the close is what a caller is being raised at. */
function closeFailureClause(outcome: CleanupOutcome): string | undefined {
  if (outcome.settlement === "closed") {
    return undefined;
  }
  const target =
    outcome.processId === undefined
      ? "an unidentified process"
      : `pid ${String(outcome.processId)}`;
  return (
    `the launched Electron did not close cleanly: ${outcome.settlement} for ${target} after ` +
    `${String(outcome.waitedMs)} ms of the ${String(outcome.budgetMs)} ms it was given` +
    (outcome.settlement === "unterminable"
      ? " — it may still be running and holding its profile, and a later launch in the same job " +
        "losing `requestSingleInstanceLock()` starts here"
      : "")
  );
}

/**
 * The error a caller must be shown, or `undefined` when nothing was left behind.
 *
 * A function rather than a conditional at the call site so the rule is stated
 * once and can be tested without launching Electron, which is the only way to
 * reach these outcomes for real. Three raise, and they are the three a later
 * launch can feel: `unterminable`, where a process nothing could kill may still
 * be holding its profile; `closed-after-rejection`, where the close failed
 * outright and the caller would otherwise never hear the rejection; and a
 * profile that could not be removed, whatever the close settled — a per-launch
 * directory left on disk is what turns the NEXT run's disk-space failure into
 * something that looks like a console defect, and it used to be a `console.error`
 * a green tier printed and nobody read.
 *
 * `terminated` is deliberately NOT one of them. It says the tree was SIGKILLed,
 * which `withCleanupOutcome` reports in the same breath as "later launches are
 * unaffected" — and a verdict cannot both say that and fail a tier over it. What
 * failing it would catch is a healthy shutdown that ran long: an Electron
 * flushing a session store on a loaded two-core runner can lose a ten-second
 * race with nothing leaked. It is a breadcrumb, not a red check.
 */
export function cleanupFailure(outcome: CleanupOutcome): CleanupFailedError | undefined {
  return outcome.settlement === "unterminable" ||
    outcome.settlement === "closed-after-rejection" ||
    outcome.profileRemovalFailure !== undefined
    ? new CleanupFailedError(outcome)
    : undefined;
}

/**
 * Run `body`, then close — and when both fail, keep the body's failure.
 *
 * `close()` is not total: it rejects when cleanup may have left something
 * behind. A caller that awaited it in a bare `finally` therefore DESTROYED
 * whatever the body had thrown, because JavaScript discards the in-flight
 * completion when a `finally` block throws — and the two co-occur by
 * construction rather than by coincidence, since a wedged renderer is exactly
 * the state in which an assertion fails AND the close then loses its race.
 *
 * The disposition is `withCleanupOutcome`'s, applied rather than restated: the
 * failure that explains the run stays as the cause, and cleanup adds only what
 * the reader could not otherwise know. A cleanup failure surfaces on its own
 * exactly when the body SUCCEEDED, which is where it IS that failure.
 *
 * Takes the close alone rather than a whole launched application, which is what
 * makes the interesting case reachable: a body that fails while the close also
 * fails is one object literal, and unproducible with a real Electron.
 */
export async function closeAfterBody<TResult>(
  application: Pick<ClosableApplication, "close">,
  body: () => Promise<TResult>,
): Promise<TResult> {
  let bodyOutcome:
    | { readonly succeeded: true; readonly value: TResult }
    | { readonly succeeded: false; readonly failure: unknown };
  try {
    bodyOutcome = { succeeded: true, value: await body() };
  } catch (failure: unknown) {
    bodyOutcome = { succeeded: false, failure };
  }
  try {
    await application.close();
  } catch (cleanupError: unknown) {
    if (bodyOutcome.succeeded) {
      throw cleanupError;
    }
    // A close that rejected with something other than the verdict has no
    // settlement to fold, and `withCleanupOutcome` hands the body's failure back
    // untouched there rather than inventing a sentence about a cleanup it cannot
    // describe. The launcher's own close does not produce that arm — it raises
    // the verdict and breadcrumbs everything else — so this is the guard for a
    // caller that closes some other way, not a path in the tiers.
    throw withCleanupOutcome(
      bodyOutcome.failure,
      cleanupError instanceof CleanupFailedError ? cleanupError.outcome : undefined,
    );
  }
  if (!bodyOutcome.succeeded) {
    throw bodyOutcome.failure;
  }
  return bodyOutcome.value;
}
