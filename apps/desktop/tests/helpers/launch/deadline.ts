// One clock for a whole `launchApp()`, so the launch cannot outlive its tier.
//
// Per-phase allowances would add up past the tier timeout, and a test vitest kills mid-phase never
// runs `close()`, leaving a live Electron and its profile behind. So one `LaunchDeadline` is split
// into three slices: the readiness ladder, the frame paint probe, and cleanup (two phases wide,
// because the SIGKILL in `cleanup/bounded.ts` is the second). Readiness waits draw what is left
// after the later two are held back. `tierTimeoutFor()` derives the tier timeout from the sum.

import { CLEANUP_BUDGET_MS, FRAME_PAINT_PROBE_TIMEOUT_MS, READINESS_BUDGET_MS } from "./budgets.js";

/**
 * How many times one cleanup can spend `CLEANUP_BUDGET_MS`.
 *
 * Two phases, not a retry of one. `cleanup/bounded.ts` races `application.close()` against the
 * figure, and a close it had to abandon is followed by a termination loop that restarts the same
 * figure at its own first attempt; the loop cannot draw on what the close left, since on the path
 * it exists for the close left nothing. Reserving the figure once would let a hung close followed
 * by a refused kill run past what the tier waits for, so vitest would kill the test before the
 * `unterminable` verdict existed and before the profile came off disk.
 *
 * A count, not a second duration, so `tests/budget/document.json` keeps one row for one bound.
 */
export const CLEANUP_PHASES = 2;

/**
 * The whole slice a launch reserves for closing, in milliseconds: the close plus the termination
 * a close it abandoned still owes, which is what `BoundedCleanup` can cost end to end. Every
 * reserve below draws from this, not from `CLEANUP_BUDGET_MS`.
 */
const CLEANUP_SLICE_MS: number = CLEANUP_BUDGET_MS * CLEANUP_PHASES;

/**
 * The most a single `launchApp()` can cost before it has thrown: the readiness ladder plus the
 * two reserved slices. A launch reaching it has already produced its own diagnostic (the readiness
 * failure, the paint probe's verdict, or the cleanup outcome), which makes the figure safe to
 * compare against a tier timeout.
 */
export const LAUNCH_BUDGET_MS: number =
  READINESS_BUDGET_MS + FRAME_PAINT_PROBE_TIMEOUT_MS + CLEANUP_SLICE_MS;

/**
 * What every readiness wait holds back, in milliseconds: the two slices after the ladder, summed
 * once here rather than at four call sites.
 */
export const POST_READINESS_RESERVE_MS: number = FRAME_PAINT_PROBE_TIMEOUT_MS + CLEANUP_SLICE_MS;

/**
 * What a tier must still have after the last slice, in milliseconds.
 *
 * It covers what runs after the last slice is spent: the synchronous `rmSync` of the temporary
 * profile and the throw propagating out through two frames, both sub-second. Two seconds is
 * roughly an order of magnitude of headroom.
 *
 * A constant here, not a `tests/budget/document.json` row, because every row there is a ceiling
 * (the loader refuses a `comparison` other than `"<="`) and this is a floor a tier must leave.
 */
export const MINIMUM_SETTLEMENT_RESIDUAL_MS = 2_000;

/**
 * The `testTimeout` a launching tier must carry, given the body allowance it applies: the launch
 * budget, then the body, then the residual. `vitest/tier-projects.ts` calls it instead of writing
 * a number. It is derived in this direction so the body's allowance is set, never whatever a
 * timeout chosen first happens to leave.
 */
export function tierTimeoutFor(bodyAllowanceMs: number): number {
  return LAUNCH_BUDGET_MS + bodyAllowanceMs + MINIMUM_SETTLEMENT_RESIDUAL_MS;
}

/**
 * The rejection a deadline raises when its own budget, rather than the work, settled first.
 *
 * A type so a caller can recognize it by identity (see `LaunchDeadline.raisedExpiry`). It carries
 * the deadline that raised it, so a nested deadline inside the work is not mistaken for the outer
 * one and its more specific phase is not reworded away.
 */
class DeadlineExpiredError extends Error {
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

/**
 * A shared clock for one launch: mint it, then draw from it.
 *
 * A class because two of its members are policy, not arithmetic (the floor under `remainingMs`,
 * and what `settleWithin` does to an operation with no timeout of its own).
 */
export class LaunchDeadline {
  readonly #expiresAt: number;

  constructor(budgetMs: number) {
    this.#expiresAt = Date.now() + budgetMs;
  }

  /**
   * Whether the budget is spent once `reservedMs` is held back.
   *
   * It takes the same reserve as `remainingMs` because a readiness phase draws
   * `remainingMs(POST_READINESS_RESERVE_MS)` and so runs out a whole paint-probe-and-cleanup
   * reserve before the launch deadline expires; the unreserved question would then say the budget
   * is fine and `readinessFailure` would return the raw phase timeout instead of the sentence
   * explaining what the phases share. Unlike `remainingMs`, which is floored at 1, it can say a
   * budget is spent.
   */
  expired(reservedMs = 0): boolean {
    return Date.now() >= this.#expiresAt - reservedMs;
  }

  /**
   * Whether `error` is this deadline's own budget expiring.
   *
   * `expired()` cannot answer this: it reads the clock a second time, and the bounding
   * `setTimeout` fires against libuv's loop time while `Date.now()` is a separate reading, so a
   * timer scheduled for N ms can fire while `Date.now()` still reads N-1 since the start.
   * Measured at a 5 ms budget: 55 of 4 000 firings, 1.4 %. `expired()` also cannot tell "my timer
   * fired" from "time has passed", so a failure the work raised after the budget was gone would
   * be blamed on the clock.
   *
   * It matches by identity, not by message or a bare `instanceof`: an inner deadline is a
   * different subject with a more specific phase, and its expiry must reach the caller as the
   * work's own failure. `cleanup/bounded.ts`'s race takes the same shape, deciding the winner
   * from the race itself and using the clock only to report duration.
   */
  raisedExpiry(error: unknown): boolean {
    return error instanceof DeadlineExpiredError && error.deadline === this;
  }

  /**
   * Milliseconds left once `reservedMs` is held back, floored at 1.
   *
   * The reserve makes three slices out of one clock: a readiness phase asks for what is left
   * after the paint probe and cleanup, so it can never spend their intervals. The floor exists
   * because every consumer passes this to Playwright as a `timeout`, and `timeout: 0` means no
   * timeout, which would turn an overrun into an unbounded wait. `expired()` is how a caller
   * asks whether the budget is spent.
   */
  remainingMs(reservedMs = 0): number {
    return Math.max(1, this.#expiresAt - Date.now() - reservedMs);
  }

  /**
   * Bound an operation that cannot bound itself.
   *
   * `page.evaluate` takes no `timeout` option, so a renderer with a wedged main thread leaves it
   * pending forever, right before the paint probe that would diagnose it. This rejects on expiry
   * rather than returning a verdict: a phase that did not settle is a launch failure, while a
   * renderer that did not paint is a finding `FramePaintProbe` words itself.
   */
  async settleWithin<T>(work: Promise<T>, phase: string, reservedMs = 0): Promise<T> {
    const budgetMs = this.remainingMs(reservedMs);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<never>((_resolveNever, rejectExpired) => {
      timeoutHandle = setTimeout(() => {
        rejectExpired(new DeadlineExpiredError(this, phase, budgetMs));
      }, budgetMs);
    });
    // `Promise.race` keeps both promises handled by calling `then` on each, so an abandoned
    // operation rejecting after the caller closes the application, or the expiry promise
    // rejecting into nothing when the work wins, cannot fail the tier. A rejection that arrives
    // first still propagates as itself.
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
 * Playwright reports what it was given, which under a shared deadline is whatever was left
 * ("Timeout 1ms exceeded" for a phase that was never the slow one). The underlying error is kept
 * as `cause`. It applies only while the deadline is spent: a phase that failed for its own
 * reasons, such as a missing selector or a crashed process, reports that reason untouched.
 */
export function readinessFailure(deadline: LaunchDeadline, error: unknown): unknown {
  // A phase bounded by `settleWithin` is answered by the deadline itself, which knows whether its
  // own timer fired, so that answer is asked first and the clock can never veto it (see
  // `raisedExpiry`). The clock reading stays for the phases Playwright bounds with a `timeout`
  // this deadline handed it: those reject with Playwright's own error, which carries no mark of
  // this deadline. It is asked with the reserve because the ladder runs out when its own
  // allowance is gone, a whole paint-probe-and-cleanup reserve before the launch deadline expires.
  if (!deadline.raisedExpiry(error) && !deadline.expired(POST_READINESS_RESERVE_MS)) {
    return error;
  }
  return new Error(
    `the app did not become ready within the ${String(READINESS_BUDGET_MS)} ms readiness ` +
      "budget, which every phase before the frame paint probe SHARES — process launch, first " +
      "window, the document's `load`, the app's frame element, the visibility read — rather " +
      "than each receiving its own; the paint probe's interval is reserved beyond this budget, " +
      "so a launch that overruns reports here rather than as the enclosing tier's timeout " +
      "(tests/helpers/launch/deadline.ts)",
    { cause: error },
  );
}
