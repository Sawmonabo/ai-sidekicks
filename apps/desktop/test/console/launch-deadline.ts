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
// WHAT THE ARITHMETIC HAS TO SATISFY
//
// `LAUNCH_BUDGET_MS + MINIMUM_SETTLEMENT_RESIDUAL_MS` must fit inside the
// `testTimeout` of every tier that launches a console. That is not asserted here
// in prose: `architecture/frame-witness.test.ts` resolves the REAL projects out
// of `vitest.config.ts` and holds the relationship against each tier's own
// resolved timeout, so lowering a tier's patience fails a test that says why
// rather than re-creating this defect quietly.

import { FRAME_WITNESS_TIMEOUT_MS } from "./frame-witness.js";

/**
 * How long the whole readiness ladder gets, in aggregate.
 *
 * This bounds a COLD Electron start on a shared CI runner, which is a different
 * quantity from anything the console's budgets measure — a tight bound here
 * would turn runner contention into a red tier, and the budget tier is where a
 * slow start is supposed to be caught. The value is the per-phase allowance the
 * harness carried before this became a deadline; what changed is that four
 * phases now SHARE it instead of each receiving it.
 */
export const READINESS_BUDGET_MS = 30_000;

/**
 * How long `application.close()` gets before the process tree is SIGKILLed.
 *
 * An APPLIED bound rather than an arithmetic one: `bounded-cleanup.ts` races the
 * close against it. The quantity it guards against is an Electron that is wedged
 * rather than slow — a close that never settles at all — so what matters is that
 * some finite number is enforced, not that this one is tight. A healthy close
 * costs well under a second locally, which is why two orders of magnitude above
 * it is generous without being reckless: nothing waits this long unless the
 * process has genuinely stopped answering.
 */
export const CLEANUP_BUDGET_MS = 10_000;

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
 * What a tier must still have after `LAUNCH_BUDGET_MS`, in milliseconds.
 *
 * Everything the budget covers is now inside it, cleanup included, so what this
 * guards is only what runs AFTER the last slice is spent: the synchronous
 * removal of the temporary profile directory, and the throw propagating out
 * through two frames. Both are sub-second — the removal is the slower of the two
 * and it is an `rmSync` over one Electron profile. Two seconds is roughly an
 * order of magnitude of headroom over that, and unlike the slices above it is a
 * floor a tier must leave rather than an interval anything waits out.
 */
export const MINIMUM_SETTLEMENT_RESIDUAL_MS = 2_000;

/**
 * A shared clock for one launch: mint it, then draw from it.
 *
 * A class rather than a captured expiry timestamp because two of its three
 * members are policy rather than arithmetic — the floor under `remainingMs`, and
 * what `settleWithin` does to an operation that carries no timeout of its own —
 * and because `now` is a seam a test supplies rather than a clock a test waits
 * on.
 */
export class LaunchDeadline {
  readonly #expiresAt: number;
  readonly #now: () => number;

  constructor(budgetMs: number, now: () => number = Date.now) {
    this.#now = now;
    this.#expiresAt = now() + budgetMs;
  }

  /** Whether the budget is spent. Distinct from `remainingMs`, which never says so. */
  expired(): boolean {
    return this.#now() >= this.#expiresAt;
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
        rejectExpired(
          new Error(
            `${phase} did not settle within the launch deadline's remaining ${String(budgetMs)} ms`,
          ),
        );
      }, budgetMs);
    });
    // An ABANDONED operation must not take the process down. When the budget
    // wins, the work is still outstanding and the caller's next act is to close
    // the application — which rejects it, with no handler attached unless one is
    // put here. Attaching does not remove `work` from the race, so a rejection
    // that arrives first still propagates.
    work.catch(() => undefined);
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
  if (!deadline.expired()) {
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
