// The allowance the caller's test body runs inside, and what happens when it ends.
//
// `launch-deadline.ts` bounds the LAUNCH and `bounded-cleanup.ts` bounds the
// close. Between them sits the thing a tier actually came for — the body — and it
// was bounded by nothing. The arithmetic that left is the finding: a launch may
// spend its whole 45 000 ms readiness-and-witness allowance, cleanup reserves
// 10 000 ms after it, and the end-to-end tier's timeout was a 60 000 ms literal,
// so a body declaring three 10 000 ms polls of its own could be killed by vitest
// mid-poll. What that costs is every diagnostic at once: the poll's own message
// never prints, the cleanup never runs, and the Electron it would have closed
// survives into the launches after it.
//
// Two halves fix it, and both live here. The body gets a bound of its own, so an
// overrun is reported in a sentence naming which allowance expired rather than as
// "test timed out in 60000ms"; and the bound is a slice the tier's timeout is
// DERIVED from (`tierTimeoutFor`), so cleanup still runs inside the tier however
// long the body was allowed.
//
// The allowance is handed to the body rather than merely applied to it. A body
// that polls needs a figure for its own `timeout`, and a body that invents one is
// a second copy of a bound that will drift from this one — so `remainingMs()` is
// what a poll is given, and it is what is LEFT rather than the whole allowance.

import { type ClosableApplication } from "./bounded-cleanup.js";
import { closeAfterBody } from "./cleanup-disposition.js";
import { BODY_ALLOWANCE_MS } from "./launch-budgets.js";
import { LaunchDeadline } from "./launch-deadline.js";

/** How an overrun names the phase that ran out. */
const TEST_BODY_PHASE = "the launched console's test body";

/**
 * One body's allowance: mint it after the launch settles, then draw from it.
 *
 * A class rather than a bare deadline because the figure and the clock are one
 * subject here: the wording of an overrun has to name the whole allowance while
 * a poll has to be handed what is left of it, and a caller holding those two
 * separately is a caller that can pass the wrong one.
 */
export class BodyAllowance {
  readonly #deadline: LaunchDeadline;
  readonly #allowanceMs: number;

  constructor(allowanceMs: number = BODY_ALLOWANCE_MS, now: () => number = Date.now) {
    this.#allowanceMs = allowanceMs;
    this.#deadline = new LaunchDeadline(allowanceMs, now);
  }

  /** The whole allowance, in milliseconds — the figure an overrun is worded against. */
  get allowanceMs(): number {
    return this.#allowanceMs;
  }

  /**
   * Milliseconds left, floored at 1 — the figure a body hands its own polls.
   *
   * Floored for the reason `LaunchDeadline` floors it: every consumer passes this
   * straight to Playwright, which reads `timeout: 0` as no timeout at all, so the
   * honest answer for a spent allowance is the one answer that must never be
   * returned.
   */
  remainingMs(): number {
    return this.#deadline.remainingMs();
  }

  /**
   * Run `body` inside the allowance, wording an overrun as the harness's own.
   *
   * A body that fails on its own reaches the caller untouched — its assertion is
   * the failure that explains the run, and a sentence about a clock over the top
   * of it would be the inversion this module exists to stop.
   */
  async settle<TResult>(body: () => Promise<TResult>): Promise<TResult> {
    try {
      return await this.#deadline.settleWithin(body(), TEST_BODY_PHASE);
    } catch (error: unknown) {
      throw this.#overrun(error);
    }
  }

  /** The sentence a reader gets instead of vitest's, or the body's own failure. */
  #overrun(error: unknown): unknown {
    if (!this.#deadline.expired()) {
      return error;
    }
    return new Error(
      `${TEST_BODY_PHASE} did not settle within the ${String(this.#allowanceMs)} ms allowance the ` +
        "harness reserves for it — the tier's own timeout is that allowance plus the launch budget " +
        "and a settlement residual, so this sentence and the close that follows it both reach you " +
        "rather than vitest killing the test mid-body and leaving an Electron alive; a tier whose " +
        "body needs longer states its own allowance (test/console/launch-budgets.ts)",
      { cause: error },
    );
  }
}

/**
 * Run `body` inside its allowance, then close — whichever of them failed.
 *
 * The wrapper's whole disposition minus the launch, so it is reachable without an
 * Electron: `closeAfterBody` OUTSIDE the allowance is the ordering that matters,
 * because an overrun that skipped the close would leave behind exactly the
 * process this bound exists to stop leaving behind.
 */
export async function withBoundedBody<TResult>(
  application: Pick<ClosableApplication, "close">,
  allowance: BodyAllowance,
  body: () => Promise<TResult>,
): Promise<TResult> {
  return await closeAfterBody(application, async () => await allowance.settle(body));
}
