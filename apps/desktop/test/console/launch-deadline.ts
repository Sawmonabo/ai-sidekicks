// One clock for a whole `launchConsole()`, so the launch cannot outlive its tier.
//
// WHAT WENT WRONG WITH A TIMEOUT PER PHASE
//
// A launch is a ladder of waits — the Electron process starts, a first window
// appears, the document reaches `load`, the console's frame element mounts, the
// renderer reports itself visible, and then the frame witness asks whether it is
// painting. Each of those used to carry its own independent allowance, and
// independent allowances ADD: four phases at 30 000 ms plus a 15 000 ms witness
// is a launch entitled to 135 000 ms inside a tier whose `testTimeout` is
// 60 000 ms.
//
// The failure that arithmetic buys is the one the witness exists to prevent. Let
// readiness run long on a contended runner and vitest's own timeout fires first:
// the test is killed mid-phase, so the witness never renders its verdict, the
// harness's breadcrumb is never printed, and `close()` never runs — leaving a
// live Electron process and a temporary profile behind for the next launch to
// trip over. What a reader gets is "test timed out in 60000ms", which names
// neither the phase that was slow nor the window that was fine.
//
// SO THE BUDGET IS THE LAUNCH'S, NOT THE PHASE'S
//
// `launchConsole()` mints one `LaunchDeadline` before its first phase, and the
// launch's whole allowance is divided into three named slices: the readiness
// ladder, the frame witness, and cleanup. Every readiness wait draws its timeout
// from what is LEFT of the deadline after the two later slices are held back, so
// the ladder costs `READINESS_BUDGET_MS` in aggregate however its phases divide
// it up — the same cold-start allowance the harness always meant and never
// enforced — and it cannot eat what comes after it.
//
// The later two are RESERVED rather than drawn from, which is the one place this
// deliberately does not share, and for the same reason twice. A witness handed
// whatever readiness left over would report "not painting" for a window that
// merely needed another second; a cleanup handed whatever the witness left over
// would have no time to close anything. Both would report the wrong cause
// loudly, which is worse than reporting nothing and is the inversion this whole
// change is undoing.
//
// CLEANUP IS A SLICE, NOT AN ARITHMETIC MARGIN
//
// It was a margin first, and that was the defect's second half: the budget left
// room for `close()` and nothing applied that room to it. `application.close()`
// was awaited unbounded, so an Electron wedged rather than merely slow consumed
// whatever the tier had left and vitest's generic timeout won anyway — the same
// undiagnosable kill, one line further down. `bounded-cleanup.ts` now races that
// close against the slice and SIGKILLs the process tree when it loses, so the
// profile is still removed and the original failure still reaches the reader.
//
// THE BODY IS A SLICE TOO, AND THE TIER TIMEOUT IS THEIR SUM
//
// A launch is not the whole of what runs inside a tier's `testTimeout`. Between
// the settled launch and the cleanup sits the caller's own test body, and it was
// budgeted by nothing: the end-to-end tier carried a 60 000 ms literal, a launch
// was entitled to 45 000 ms of it and cleanup reserved 10 000 ms more, so a body
// with three 10 000 ms polls of its own could be killed by vitest mid-poll —
// before the poll's message, before the cleanup, with an Electron left alive.
//
// So the tier timeout is DERIVED rather than written down: `tierTimeoutFor()`
// sums the launch budget, the body allowance that tier applies, and the
// settlement residual, and `vitest.config.ts` carries the call instead of a
// number. `architecture/launch-deadline.test.ts` resolves the REAL projects out
// of that config and holds each tier's own `testTimeout` and `hookTimeout`
// against the derived figures, so a literal re-planted there fails a test that
// says why rather than re-creating this defect quietly.

import {
  CLEANUP_BUDGET_MS,
  FRAME_WITNESS_TIMEOUT_MS,
  READINESS_BUDGET_MS,
} from "./launch-budgets.js";

/**
 * The most a single `launchConsole()` can cost before it has thrown.
 *
 * Derived, never chosen: the readiness ladder plus the two reserved slices. A
 * launch that reaches this figure has already produced its own diagnostic — the
 * readiness failure, the witness's verdict, or the cleanup outcome attached to
 * whichever of them started it — which is the property that makes the number
 * safe to compare against a tier timeout.
 */
export const LAUNCH_BUDGET_MS: number =
  READINESS_BUDGET_MS + FRAME_WITNESS_TIMEOUT_MS + CLEANUP_BUDGET_MS;

/**
 * What every readiness wait holds back, in milliseconds.
 *
 * The two slices that come after the ladder, summed once here rather than added
 * up at four call sites — a reserve that is right in three places and wrong in
 * the fourth is the shape of defect this whole module exists to remove.
 */
export const POST_READINESS_RESERVE_MS: number = FRAME_WITNESS_TIMEOUT_MS + CLEANUP_BUDGET_MS;

/**
 * What a tier must still have after the last slice, in milliseconds.
 *
 * Everything the budget covers is inside the slices, cleanup included, so what
 * this guards is only what runs AFTER the last of them is spent: the synchronous
 * removal of the temporary profile directory, and the throw propagating out
 * through two frames. Both are sub-second — the removal is the slower of the two
 * and it is an `rmSync` over one Electron profile. Two seconds is roughly an
 * order of magnitude of headroom over that.
 *
 * A constant here rather than a `budgets.json` row, unlike every other figure in
 * this arithmetic, and for a reason the registry states about itself: every row
 * there is a CEILING — the loader refuses a `comparison` that is not `"<="` — and
 * this is a floor a tier must leave rather than an interval anything waits out.
 * Registering it would have to weaken that invariant to hold one number.
 */
export const MINIMUM_SETTLEMENT_RESIDUAL_MS = 2_000;

/**
 * The `testTimeout` a launching tier must carry, given the body allowance it applies.
 *
 * The one arithmetic, in one place, and `vitest.config.ts` calls it rather than
 * writing a number: a launch, then the body, then the cleanup the launch budget
 * already reserves, then the residual. Derived in this direction on purpose — a
 * tier timeout chosen first and sliced afterwards is how the body came to be the
 * one phase with no allowance at all.
 */
export function tierTimeoutFor(bodyAllowanceMs: number): number {
  return LAUNCH_BUDGET_MS + bodyAllowanceMs + MINIMUM_SETTLEMENT_RESIDUAL_MS;
}

/**
 * A shared clock for one launch: mint it, then draw from it.
 *
 * A class rather than a captured expiry timestamp because two of its three
 * members are policy rather than arithmetic — the floor under `remainingMs`, and
 * what `settleWithin` does to an operation that carries no timeout of its own —
 * and because `now` is a seam a test supplies rather than a clock a test waits
 * on.
 */
/**
 * The rejection a deadline raises when its OWN budget, rather than the work, settled first.
 *
 * A type rather than a bare `Error` so a caller can recognise it by identity. What a
 * caller actually wants to know — "was that my budget, or did the work fail?" — was
 * previously re-derived by reading the clock a second time, which answers a different
 * question and answers it wrong at the boundary (`LaunchDeadline.raisedExpiry`).
 *
 * Carries the deadline that raised it rather than only its own name: a nested deadline
 * inside the work would otherwise be mistaken for the outer one and have its more
 * specific phase reworded away.
 *
 * The message is unchanged from the sentence this replaced, and deliberately so — it
 * is what a reader sees when no caller rewords it, and rewording it here would move
 * text that suites already read.
 */
export class DeadlineExpiredError extends Error {
  /** The deadline whose budget expired. Compared by identity, never by name. */
  readonly deadline: LaunchDeadline;
  /** The phase that was being bounded, as the deadline was told to call it. */
  readonly phase: string;
  /** What the budget was when this bound was armed, in milliseconds. */
  readonly budgetMs: number;

  constructor(deadline: LaunchDeadline, phase: string, budgetMs: number) {
    super(`${phase} did not settle within the deadline's remaining ${String(budgetMs)} ms`);
    this.name = "DeadlineExpiredError";
    this.deadline = deadline;
    this.phase = phase;
    this.budgetMs = budgetMs;
  }
}

export class LaunchDeadline {
  readonly #expiresAt: number;
  readonly #now: () => number;

  constructor(budgetMs: number, now: () => number = Date.now) {
    this.#now = now;
    this.#expiresAt = now() + budgetMs;
  }

  /**
   * Whether the budget is spent once `reservedMs` is held back.
   *
   * Takes the same reserve `remainingMs` does, and for a reason that was a live
   * defect rather than symmetry for its own sake. A readiness phase draws
   * `remainingMs(POST_READINESS_RESERVE_MS)`, so it runs out of time 25 000 ms
   * BEFORE the launch deadline expires — and a caller asking the unreserved
   * question at that moment is told the budget is fine. `readinessFailure` asked
   * exactly that, so the one case it exists for, a ladder that used its whole
   * aggregate allowance, returned the raw phase timeout ("Timeout 1ms exceeded")
   * instead of the sentence explaining what the phases share.
   *
   * Distinct from `remainingMs`, which never says a budget is spent because it
   * cannot: it is floored at 1 for a caller that hands it straight to Playwright.
   */
  expired(reservedMs = 0): boolean {
    return this.#now() >= this.#expiresAt - reservedMs;
  }

  /**
   * Whether `error` is THIS deadline's own budget expiring.
   *
   * The question `expired()` cannot answer, and the reason it must not be asked to.
   * `expired()` reads the clock a SECOND time, and the two readings disagree: the
   * bounding `setTimeout` fires against libuv's loop time while `Date.now()` is a
   * separate reading of the same instant, and a timer scheduled for N milliseconds
   * can fire while `Date.now()` still reads N-1 since the start. Measured at a 5 ms
   * budget on the authoring machine: 55 of 4 000 firings, 1.4 %. A caller deciding
   * "was it my budget that fired" from `expired()` therefore answers NO to its own
   * timer roughly one time in seventy, and reports the expiry in the wrong words.
   *
   * It also cannot separate "my timer fired" from "time has passed", so a failure
   * the WORK raised after the budget was gone was being blamed on the clock — the
   * inversion `launch-body.ts` says in its own header that it exists to stop.
   *
   * Identity rather than a message match or a bare `instanceof`: an inner deadline
   * inside the work is a different subject with a more specific phase, and its
   * expiry must reach the caller as the work's own failure rather than be reworded
   * as this one's.
   *
   * The precedent is `bounded-cleanup.ts`'s own race, which was written this way from
   * the start: it resolves a discriminated `"closed" | "expired" | "rejected"` out of
   * the race itself and reads the clock only to REPORT how long the close took, never
   * to decide which side won. This method brings the deadline to that shape.
   */
  raisedExpiry(error: unknown): boolean {
    return error instanceof DeadlineExpiredError && error.deadline === this;
  }

  /**
   * Milliseconds left once `reservedMs` is held back, floored at 1.
   *
   * The reserve is what makes three slices out of one clock: a readiness phase
   * asks for what is left AFTER the witness and cleanup, so however slowly the
   * ladder runs it can never spend their intervals. Passing nothing reserves
   * nothing, which is what the last slice wants.
   *
   * Deliberately never 0. Every consumer passes this figure to Playwright as a
   * `timeout`, and Playwright reads `timeout: 0` as "no timeout at all", so the
   * honest answer for an exhausted deadline is the one answer that must never be
   * returned: it would convert an overrun into an unbounded wait, precisely the
   * failure this class exists to remove. The floor makes an exhausted deadline
   * fail immediately instead, and `expired()` is how a caller asks the question
   * this method will not answer.
   */
  remainingMs(reservedMs = 0): number {
    return Math.max(1, this.#expiresAt - this.#now() - reservedMs);
  }

  /**
   * Bound an operation that cannot bound itself.
   *
   * `page.evaluate` takes no `timeout` option and is not governed by
   * Playwright's default timeout, so a renderer whose main thread is wedged
   * leaves the round trip pending forever — the readiness ladder's one
   * unbounded step, and the one that runs immediately before the witness that
   * would have diagnosed it.
   *
   * Rejects on expiry rather than returning a verdict, which is the difference
   * between this and `FrameWitness`: a phase that did not settle is a launch
   * failure, while a renderer that did not paint is a finding the harness
   * words itself.
   */
  async settleWithin<T>(work: Promise<T>, phase: string, reservedMs = 0): Promise<T> {
    const budgetMs = this.remainingMs(reservedMs);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<never>((_resolveNever, rejectExpired) => {
      timeoutHandle = setTimeout(() => {
        rejectExpired(new DeadlineExpiredError(this, phase, budgetMs));
      }, budgetMs);
    });
    // An ABANDONED operation must not take the process down. When the budget
    // wins, the work is still outstanding and the caller's next act is to close
    // the application — which rejects it; unhandled, that fails the tier on
    // something other than the phase's verdict. The same is true in reverse:
    // when the work wins, the expiry promise above rejects into nothing.
    //
    // `Promise.race` is what stops both, by calling `then` on each promise, so
    // whichever loses stays handled for the rest of its life. A bare
    // `work.catch(() => undefined)` used to sit here claiming to be the
    // mechanism, and it was a second handler on an already-handled promise. The
    // claim lives in `architecture/launch-deadline.test.ts` instead, where an
    // abandoned operation is rejected and the process is asserted never to have
    // been told. Racing rather than only bounding also keeps a rejection that
    // arrives first propagating as itself.
    try {
      return await Promise.race([work, budgetExpired]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Re-word a readiness failure as one about the budget the ladder actually shares.
 *
 * Playwright reports what IT was given, which under a shared deadline is
 * whatever was left — "Timeout 1ms exceeded" for a phase that was never the slow
 * one. The underlying error is kept as `cause`, because which phase ran out is
 * still the first thing a reader wants.
 *
 * Applied only while the deadline is spent. A phase that failed for its own
 * reasons — a missing selector, a crashed process — reports that reason
 * untouched rather than being blamed on a clock with time left on it.
 */
export function readinessFailure(deadline: LaunchDeadline, error: unknown): unknown {
  // TWO QUESTIONS, AND THE FIRST IS THE ONLY EXACT ONE. A phase bounded by
  // `settleWithin` is answered by the deadline itself, which knows whether its own
  // timer fired; the clock reading below can only guess, and guesses wrong roughly
  // one firing in seventy because a `setTimeout` and `Date.now()` are separate
  // readings of one instant (see `raisedExpiry`). So the deadline's own answer is
  // asked FIRST and can never be vetoed by the clock.
  //
  // The clock reading stays because the other phases here are Playwright's, bounded
  // by a `timeout` this deadline handed them: those reject with Playwright's own
  // error, which carries no mark of this deadline, and the reading is then the only
  // signal there is. Asked WITH the reserve, because the readiness ladder ran out of
  // time when its own allowance was gone, not when the whole launch deadline expires
  // — those are 25 000 ms apart, and asking the unreserved question meant this
  // returned the raw phase timeout in precisely the case it was written for.
  if (!deadline.raisedExpiry(error) && !deadline.expired(POST_READINESS_RESERVE_MS)) {
    return error;
  }
  return new Error(
    `the console did not become ready within the ${String(READINESS_BUDGET_MS)} ms readiness budget, ` +
      "which every phase before the frame witness SHARES — process launch, first window, the " +
      "document's `load`, the console's frame element, the visibility read — rather than each " +
      "receiving its own; the witness's interval is reserved beyond this budget, so a launch that " +
      "overruns reports here rather than as the enclosing tier's timeout (test/console/launch-deadline.ts)",
    { cause: error },
  );
}
