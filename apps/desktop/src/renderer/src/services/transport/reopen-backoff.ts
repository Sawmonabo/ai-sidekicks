// The waits between re-opens of one daemon stream. A stream that ends after it delivered is opened
// again at once, then after growing waits while each re-opened stream ends at once, so a stream
// that delivers and ends every time is not opened in a loop; one that stays open a while starts the
// waits over. Every stream the renderer keeps open re-opens through this one rule.

import type { Clock, ScheduledHandle } from "#renderer/lib/clock.js";

/**
 * The waits before each re-open in a row of streams that ended at once or re-opens that threw, in
 * milliseconds: the first is at once and the last repeats, as the main process's restarts of the
 * service grow.
 */
export const REOPEN_WAITS_MS: readonly number[] = [0, 100, 300, 1_000, 3_000, 10_000];

/** How long a stream stays open before its end starts the re-open waits over, in milliseconds. */
export const REOPEN_SETTLED_MS = 10_000;

/** One stream's place in the waits: how many re-opens ran in a row, and the one waiting now. */
export class ReopenBackoff {
  readonly #clock: Clock;
  /** Re-opens in a row since a stream last stayed open {@link REOPEN_SETTLED_MS}. */
  #reopensInARow = 0;
  #waitHandle: ScheduledHandle | undefined;

  public constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Note that a stream opened at `openedAt` ended now; one that lasted starts the waits over. */
  public noteEnded(openedAt: number): void {
    if (this.#clock.now() - openedAt >= REOPEN_SETTLED_MS) {
      this.#reopensInARow = 0;
    }
  }

  /** Skip the wait of none, for a re-open after an open that just threw. */
  public skipImmediateReopen(): void {
    this.#reopensInARow = Math.max(this.#reopensInARow, 1);
  }

  /**
   * Run `reopen` after the next wait: at once when that wait is none. Nothing while a wait is
   * already pending, so two ends in a row schedule one re-open.
   */
  public schedule(reopen: () => void): void {
    if (this.#waitHandle !== undefined) {
      return;
    }
    const waitMs = REOPEN_WAITS_MS[Math.min(this.#reopensInARow, REOPEN_WAITS_MS.length - 1)]!;
    this.#reopensInARow += 1;
    if (waitMs === 0) {
      reopen();
      return;
    }
    this.#waitHandle = this.#clock.scheduleTimeout(() => {
      this.#waitHandle = undefined;
      reopen();
    }, waitMs);
  }

  /** Drop the pending re-open, if one is waiting. */
  public cancel(): void {
    if (this.#waitHandle !== undefined) {
      this.#clock.cancel(this.#waitHandle);
      this.#waitHandle = undefined;
    }
  }
}
