// What a caller is told when a close did not go cleanly, and whose failure wins.
//
// `bounded-cleanup.ts` owns the race; this owns the disposition of its verdict: which outcomes a
// caller must be shown, how they are worded, and what happens when the test body failed too.
//
// Outcomes a later launch can feel raise; a tree that was SIGKILLed and is therefore gone is only
// a breadcrumb. `cleanupFailure` draws that line once.

import { type CleanupOutcome, type ClosableApplication } from "./cleanup-contract.js";
import { type ProfileRemovalFailure } from "./launch-profile.js";

/**
 * The clause about a profile that outlived its launch, or nothing.
 *
 * One wording for both readers below; it gives the path and says the next launch adds another.
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
 * Puts `clauses` above the failure that explains the run, or hands it back whole.
 *
 * The original error stays the `cause` and is announced as such.
 */
function withClauses(error: unknown, clauses: readonly string[]): unknown {
  return clauses.length === 0
    ? error
    : new Error(`${clauses.join("; ")}; the failure that started this is the cause below`, {
        cause: error,
      });
}

/**
 * Re-words a failure whose cleanup also went wrong, without losing either.
 *
 * The original stays as `cause`; this adds only what the reader could not otherwise know: a
 * process may still be running, or a profile is still on disk. It is silent on a clean close so
 * the one sentence that matters is not lost among routine ones. It names no phase because it is
 * reached from the launch's failure path and from `closeAfterBody`, where the failure kept is a
 * test body's assertion.
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
 * Folds a profile that outlived its launch into the failure that explains the run.
 *
 * The pre-launch counterpart to `withCleanupOutcome`: a launch that threw before producing an
 * application has no verdict to carry the removal, and raising it instead would replace a
 * readiness failure with a sentence about a directory.
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
 * Asked once so every wording branches on the answer instead of appending the same parenthetical
 * to both.
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
  // A close that rejects at once while the process is still alive is terminated without waiting
  // out the budget, so the wording must not claim the budget expired: a timeout and an outright
  // failure have different causes and fixes.
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
 * Thrown rather than logged: a `console.error` is not a failure to vitest, so a passing tier would
 * leave an Electron alive for the launches after it. Names the settlement and the process id, and
 * the profile directory when that is what went wrong.
 */
class CleanupFailedError extends Error {
  /**
   * The verdict this error was built from.
   *
   * Carried whole so a caller folding it into its own failure (`closeAfterBody`) passes it to
   * `withCleanupOutcome` instead of re-deriving it from the message.
   */
  readonly outcome: CleanupOutcome;

  constructor(outcome: CleanupOutcome) {
    // The removal's error becomes the cause only where the close produced none: a rejected close
    // is the earlier and more explanatory of the two.
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
 * Three outcomes raise, the three a later launch can feel: `unterminable` (a process nothing could
 * kill may still hold its profile), `closed-after-rejection` (the caller would otherwise never
 * hear the rejection), and a profile that could not be removed, whatever the close settled.
 * `terminated` does not raise: the tree is gone and `withCleanupOutcome` reports later launches as
 * unaffected, so failing a tier over it would only catch a healthy shutdown that ran long.
 */
export function cleanupFailure(outcome: CleanupOutcome): CleanupFailedError | undefined {
  return outcome.settlement === "unterminable" ||
    outcome.settlement === "closed-after-rejection" ||
    outcome.profileRemovalFailure !== undefined
    ? new CleanupFailedError(outcome)
    : undefined;
}

/**
 * Runs `body`, then closes, and when both fail keeps the body's failure.
 *
 * `close()` rejects when cleanup may have left something behind, and awaiting it in a bare
 * `finally` would discard whatever the body threw. The two co-occur by construction: a wedged
 * renderer fails an assertion and then loses the close race. The body's failure stays as the cause
 * with `withCleanupOutcome`'s additions; a cleanup failure surfaces alone only when the body
 * succeeded. Takes the close alone so a test can make both fail with one object literal.
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
    // A close that rejected with something other than the verdict has no settlement to fold, so
    // `withCleanupOutcome` hands the body's failure back untouched. The launcher's own close raises
    // only the verdict, so this guards a caller that closes some other way.
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
