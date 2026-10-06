// The allowance the caller's test body runs inside, and what happens when it ends.
//
// `deadline.ts` bounds the launch and `cleanup/bounded.ts` bounds the close; this bounds
// the body between them. An unbounded body can be killed by vitest mid-poll, so the poll's own
// message never prints, cleanup never runs and the Electron survives into later launches. The
// body gets a bound of its own, worded to name which allowance expired, and the tier's timeout is
// derived from it (`tierTimeoutFor`) so cleanup still runs inside the tier.
//
// The allowance is handed to the body: `remainingMs()` is what a poll is given, so a body does
// not invent a second copy of the bound. A wait's own bound is not enough alone: `boundedMs`
// takes the wait's own bound and the remainder and the smaller wins, so the first wait that
// cannot fit fails with its own message instead of the generic overrun.

import { type ClosableApplication } from "../cleanup/contract.js";
import { closeAfterBody } from "../cleanup/disposition.js";
import { BODY_ALLOWANCE_MS } from "./budgets.js";
import { LaunchDeadline } from "./deadline.js";

/** How an overrun names the phase that ran out. */
const TEST_BODY_PHASE = "the launched app's test body";

/**
 * The bound one in-window step gets before the app is called stopped. A view mounting, an
 * overlay opening or a durable write landing is sub-second work on any runner, so this catches a
 * stopped app, not a slow one. It is one figure for the class, shared by both launching
 * tiers, and a bound a wait declares rather than a ceiling a reading is compared to, so it is
 * not a `tests/budget/document.json` row.
 */
export const IN_WINDOW_STEP_TIMEOUT_MS = 10_000;

/**
 * One body's allowance: mint it after the launch settles, then draw from it. A class because an
 * overrun is worded against the whole allowance while a poll is handed what is left of it.
 */
export class BodyAllowance {
  readonly #deadline: LaunchDeadline;
  readonly #allowanceMs: number;

  constructor(allowanceMs: number = BODY_ALLOWANCE_MS) {
    this.#allowanceMs = allowanceMs;
    this.#deadline = new LaunchDeadline(allowanceMs);
  }

  /**
   * Milliseconds left, floored at 1 like `LaunchDeadline`'s: Playwright reads `timeout: 0` as no
   * timeout, so a spent allowance must never return 0.
   */
  remainingMs(): number {
    return this.#deadline.remainingMs();
  }

  /**
   * The timeout for one bounded wait: its own bound or what is left of the allowance, whichever
   * is smaller. The wait's own bound makes a stalled step report as a stalled step; the
   * remainder stops a wait from outrunning an allowance with little left, where the enclosing
   * race would replace the wait's sentence with the generic overrun. Never zero.
   */
  boundedMs(ownBoundMs: number): number {
    return Math.min(ownBoundMs, this.remainingMs());
  }

  /**
   * Run `body` inside the allowance, wording an overrun as the harness's own. A body that fails
   * on its own reaches the caller untouched, since its assertion is what explains the run.
   */
  async settle<TResult>(body: () => Promise<TResult>): Promise<TResult> {
    try {
      return await this.#deadline.settleWithin(body(), TEST_BODY_PHASE);
    } catch (error: unknown) {
      throw this.#overrun(error);
    }
  }

  /**
   * The sentence a reader gets instead of vitest's, or the body's own failure. It asks the
   * deadline whether its own bound rejected, not the clock: a `setTimeout` and `Date.now()` are
   * separate readings, so the timer can fire while the clock still reads short (55 of 4 000 at a
   * 5 ms budget), and a body failing after the allowance would have its assertion replaced.
   */
  #overrun(error: unknown): unknown {
    if (!this.#deadline.raisedExpiry(error)) {
      return error;
    }
    return new Error(
      `${TEST_BODY_PHASE} did not settle within the ${String(this.#allowanceMs)} ms allowance ` +
        "the harness reserves for it — the tier's own timeout is that allowance plus the " +
        "launch budget and a settlement residual, so this sentence and the close that follows " +
        "it both reach you rather than vitest killing the test mid-body and leaving an " +
        "Electron alive; a tier whose body needs longer states its own allowance " +
        "(tests/helpers/launch/budgets.ts)",
      { cause: error },
    );
  }
}

/**
 * Run `body` inside its allowance, then close, whichever failed. `closeAfterBody` sits outside
 * the allowance so an overrun still closes the process.
 */
export async function withBoundedBody<TResult>(
  application: Pick<ClosableApplication, "close">,
  allowance: BodyAllowance,
  body: () => Promise<TResult>,
): Promise<TResult> {
  return await closeAfterBody(application, async () => await allowance.settle(body));
}
