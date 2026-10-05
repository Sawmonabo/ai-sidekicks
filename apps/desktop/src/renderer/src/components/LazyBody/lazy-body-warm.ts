// The idle walk that leaves every loader-backed body on a board warm, so the first open is warm
// without the launch paying for it. It is a one-shot, not a refresh, so it is not on
// `lib/reads/refresh/refresh-scheduler.ts`; a second start on one instance is a no-op.
//
// One key per idle callback, so the walk never holds the main thread through a painted frame.
// One callback per key: a board releases a key's memo when its load rejects, so without the
// attempted set two failing chunks would be refetched forever. A failed chunk is retried when a
// person opens that pane or screen.

import type { PreloadableRegistry } from "./lazy-body.js";

/**
 * The delay used when the host has no idle callback; in practice only a test environment. Short
 * enough that a person cannot reach a control before the warm has started.
 */
export const LAZY_BODY_WARM_FALLBACK_DELAY_MS = 200;

/** What the walk needs from a scheduler, so a test can drive it without a browser. */
export interface IdleWarmScheduler {
  /** Arm one step. Returns the handle its own `cancel` understands. */
  readonly schedule: (step: () => void) => number;
  readonly cancel: (handle: number) => void;
}

/**
 * Walks a board's unloaded bodies, one per idle callback, once. Generic in the key so the pane
 * and screen registries share it; `cancel` releases the scheduled handle when the window goes.
 */
export class LazyBodyIdleWarm<TKey> {
  readonly #board: PreloadableRegistry<TKey>;
  readonly #scheduler: IdleWarmScheduler;
  /** Every key this walk has armed a step for; bounded by the board's closed key set. */
  readonly #attemptedKeys = new Set<TKey>();
  #scheduledHandle: number | undefined;
  #hasStarted = false;
  #isCanceled = false;

  public constructor(board: PreloadableRegistry<TKey>, scheduler: IdleWarmScheduler) {
    this.#board = board;
    this.#scheduler = scheduler;
  }

  /**
   * Begins the walk unless it has begun or been canceled, so a late start cannot outlive a
   * teardown.
   */
  public start(): void {
    if (this.#hasStarted || this.#isCanceled) {
      return;
    }
    this.#hasStarted = true;
    this.#armNextStep();
  }

  /** Stop the walk wherever it is. Safe to call before `start` and twice after it. */
  public cancel(): void {
    this.#isCanceled = true;
    if (this.#scheduledHandle !== undefined) {
      this.#scheduler.cancel(this.#scheduledHandle);
      this.#scheduledHandle = undefined;
    }
  }

  #armNextStep(): void {
    if (this.#isCanceled) {
      return;
    }
    // The board is re-read every step because late registrations and mid-walk opens change
    // what is left. It cannot tell a rejected key from one never asked for, so the attempted
    // set filters.
    const nextKey = this.#board
      .unloadedKeys()
      .find((candidateKey) => !this.#attemptedKeys.has(candidateKey));
    if (nextKey === undefined) {
      this.#scheduledHandle = undefined;
      return;
    }
    // Marked at arm time: the walk re-arms before the load settles.
    this.#attemptedKeys.add(nextKey);
    this.#scheduledHandle = this.#scheduler.schedule(() => {
      this.#scheduledHandle = undefined;
      this.#warmThenContinue(nextKey);
    });
  }

  #warmThenContinue(key: TKey): void {
    if (this.#isCanceled) {
      return;
    }
    void preloadQuietly(this.#board.preload(key));
    // Armed at once so the walk does not serialize behind the slowest chunk. The attempted set,
    // not the board's memo, stops a key being re-selected: the memo is released on rejection.
    this.#armNextStep();
  }
}

/**
 * Settles once a speculative preload has, whichever way it went. A failure is dropped here because
 * nobody waits on a warm: the board releases the failed memo, so the mount that needs the chunk
 * loads it again and its error boundary reports the failure.
 */
export function preloadQuietly(preload: Promise<unknown>): Promise<void> {
  return preload.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * The host's idle scheduler, or a timeout fallback. Both `requestIdleCallback` and
 * `cancelIdleCallback` must exist, so a walk can always be stopped.
 */
export function idleWarmScheduler(host: IdleCallbackHost = globalThis): IdleWarmScheduler {
  const requestIdle = host.requestIdleCallback;
  const cancelIdle = host.cancelIdleCallback;
  if (typeof requestIdle === "function" && typeof cancelIdle === "function") {
    return {
      schedule: (step) => requestIdle.call(host, step),
      cancel: (handle) => {
        cancelIdle.call(host, handle);
      },
    };
  }
  return {
    schedule: (step) => host.setTimeout.call(host, step, LAZY_BODY_WARM_FALLBACK_DELAY_MS),
    cancel: (handle) => {
      host.clearTimeout.call(host, handle);
    },
  };
}

interface IdleCallbackHost {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
}
