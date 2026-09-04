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
// `launchConsole()` mints one `LaunchDeadline` before its first phase and every
// readiness wait draws its timeout from what is LEFT of it. The ladder therefore
// costs `READINESS_BUDGET_MS` in aggregate however the phases divide it up, which
// is the same cold-start allowance the harness always meant and never enforced.
//
// The witness's budget is RESERVED beyond that rather than drawn from it, which
// is the one place this deliberately does not share. A witness handed whatever
// readiness left over would report "not painting" for a window that merely
// needed another second, and reporting the wrong cause loudly is worse than
// reporting nothing — that inversion is the defect this whole change is undoing.
// Readiness therefore fails as readiness, and the witness always gets the full
// interval its own measurement derived.
//
// WHAT THE ARITHMETIC HAS TO SATISFY
//
// `LAUNCH_BUDGET_MS + MINIMUM_CLEANUP_MARGIN_MS` must fit inside the `testTimeout`
// of every tier that launches a console. That is not asserted here in prose:
// `architecture/frame-witness.test.ts` resolves the REAL projects out of
// `vitest.config.ts` and holds the relationship against each tier's own resolved
// timeout, so lowering a tier's patience fails a test that says why rather than
// re-creating this defect quietly.

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
 * The most a single `launchConsole()` can cost before it has thrown.
 *
 * Derived, never chosen: readiness plus the witness's reserved interval. A
 * launch that reaches this figure has already produced its own diagnostic — the
 * readiness failure or the witness's verdict — which is the property that makes
 * the number safe to compare against a tier timeout.
 */
export const LAUNCH_BUDGET_MS: number = READINESS_BUDGET_MS + FRAME_WITNESS_TIMEOUT_MS;

/**
 * What a tier must have left over after `LAUNCH_BUDGET_MS`, in milliseconds.
 *
 * Only the FAILURE path spends the full budget, and on that path there is no
 * test body left to run: what remains is `close()` — Playwright's application
 * close, then removing the temporary profile — and the throw propagating out.
 * That costs well under a second locally. The floor is set two orders of
 * magnitude above it because the quantity it really guards against is an
 * Electron that is wedged rather than slow, where `close()` waits on its own
 * internal timeout; and because being generous here costs nothing at all on the
 * success path, where a launch settles in seconds and hands the rest of the
 * tier's budget to the test body.
 */
export const MINIMUM_CLEANUP_MARGIN_MS = 10_000;

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
   * Milliseconds left, floored at 1 — deliberately never 0.
   *
   * Every consumer of this figure passes it to Playwright as a `timeout`, and
   * Playwright reads `timeout: 0` as "no timeout at all". So the honest answer
   * for an exhausted deadline is the one answer that must never be returned: it
   * would convert an overrun into an unbounded wait, which is precisely the
   * failure this class exists to remove. The floor makes an exhausted deadline
   * fail immediately instead, and `expired()` is how a caller asks the question
   * this method will not answer.
   */
  remainingMs(): number {
    return Math.max(1, this.#expiresAt - this.#now());
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
  async settleWithin<T>(work: Promise<T>, phase: string): Promise<T> {
    const budgetMs = this.remainingMs();
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
