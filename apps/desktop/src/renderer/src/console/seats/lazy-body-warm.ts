// The idle walk that leaves every loader-backed body on a board warm.
//
// WHAT IT BUYS, STATED AS THE TRADE IT IS. A static import and a preloaded loader end
// with the same code in the same renderer; they differ only in when it is fetched and
// what it is charged to. A static import is charged to the launch, on the initial
// import graph, for every pane a session never opens — which is what pushed the
// `renderer-initial-bundle` budget past its ceiling. A preload is charged to an idle
// callback after the first frame has committed, when the window is already painted and
// the person has not yet reached a control. So the first open of any pane is warm
// either way, and only one of the two makes the launch pay for it.
//
// AT MOST ONCE PER WALK. The walk is not a refresh and has no schedule — it is a
// one-shot that ends when the board is warm — so it is deliberately not on
// `store/scheduling.ts`, which owns REFRESHES and their absolute deadline. A second
// start on one instance is a no-op rather than a second walk, because the two callers
// that could plausibly both fire (a frame that mounts twice under StrictMode) must not
// double-schedule.
//
// ONE KEY PER CALLBACK, not a loop inside one. `requestIdleCallback` hands back a
// deadline and a walk that ignored it would do exactly what an idle callback exists to
// avoid: hold the main thread through a frame the person is looking at. Re-arming per
// kind lets the browser put the rest of the walk after whatever it would rather do.
//
// AND ONE CALLBACK PER KEY, which is the half the board cannot supply. `unloadedKeys` is
// re-read between steps, and a board releases a key's memo when its load REJECTS — so a
// chunk that will not fetch is offered back to the walk, and with two of them the walk
// alternates between the two forever, one background refetch per idle callback, for a
// surface nobody has opened. The attempted set below is what bounds it: a walk asks for
// each key once and then ends, and the retry a failed chunk gets is the one a person
// asks for by opening the surface.

import type { LazyBodyBoard } from "./lazy-body.js";

/**
 * How long after the first frame the walk waits when the host has no idle callback.
 *
 * A floor rather than a target. `requestIdleCallback` is the right instrument and
 * Chromium has it, so this value is only ever reached in a test environment or a host
 * that has dropped the API; 200 ms is past the frame the launch is judged on
 * (`time-to-first-ledger-row`, 800 ms from window show) while still being sooner than a
 * person can cross the window to a control.
 */
export const LAZY_BODY_WARM_FALLBACK_DELAY_MS = 200;

/** What the walk needs from a scheduler, so a test can drive it without a browser. */
export interface IdleWarmScheduler {
  /** Arm one step. Returns the handle its own `cancel` understands. */
  readonly schedule: (step: () => void) => number;
  readonly cancel: (handle: number) => void;
}

interface IdleCallbackHost {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
}

/**
 * The host's idle scheduler, or the timeout floor beneath it.
 *
 * FEATURE-DETECTED ON BOTH HALVES, because a host that has `requestIdleCallback` and
 * not `cancelIdleCallback` would leave this walk unable to stop — and an uncancellable
 * background walk outliving the window that started it is the leak this seam exists to
 * make impossible. Detecting the pair together is what keeps the two branches honest:
 * whichever is chosen, `schedule` and `cancel` come from the same API.
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

/**
 * Walk a board's unloaded bodies, one per idle callback, once.
 *
 * GENERIC IN THE KEY BECAUSE THE WALK IS. The deck's board is keyed by pane kind and the
 * frame's by surface slot, and the walk is the same walk over both — a second copy keyed
 * on the other would be one scheduler to keep in step with another, and the two would
 * drift the first time either grew a rule.
 *
 * A class because the walk is a resource with a lifetime: it holds a scheduled handle
 * that has to be released when the window that started it goes away, and the
 * once-per-instance rule is state. `start` returns nothing and `cancel` is what a
 * caller keeps — the shape every effect in this console already uses.
 */
export class LazyBodyIdleWarm<TKey> {
  readonly #board: LazyBodyBoard<TKey>;
  readonly #scheduler: IdleWarmScheduler;
  /**
   * Every key this walk has armed a step for, so none is armed twice.
   *
   * Bounded by the board's own closed key set — pane kinds, surface slots, settings
   * sections — and released with the walk, which is the effect's lifetime.
   */
  readonly #attemptedKeys = new Set<TKey>();
  #scheduledHandle: number | undefined;
  #hasStarted = false;
  #isCancelled = false;

  public constructor(board: LazyBodyBoard<TKey>, scheduler: IdleWarmScheduler) {
    this.#board = board;
    this.#scheduler = scheduler;
  }

  /** Has the walk been started? Read by its own test; never by a render. */
  public get hasStarted(): boolean {
    return this.#hasStarted;
  }

  /**
   * Begin the walk, if it has not begun and has not been cancelled.
   *
   * The cancelled arm matters as much as the started one: an effect that tore down and
   * whose cleanup ran before a queued start would otherwise re-arm a walk for a window
   * that is gone.
   */
  public start(): void {
    if (this.#hasStarted || this.#isCancelled) {
      return;
    }
    this.#hasStarted = true;
    this.#armNextStep();
  }

  /** Stop the walk wherever it is. Safe to call before `start` and twice after it. */
  public cancel(): void {
    this.#isCancelled = true;
    if (this.#scheduledHandle !== undefined) {
      this.#scheduler.cancel(this.#scheduledHandle);
      this.#scheduledHandle = undefined;
    }
  }

  #armNextStep(): void {
    if (this.#isCancelled) {
      return;
    }
    // Re-read the board on every step rather than snapshotting it once. A family that
    // registered late, and a kind a person opened mid-walk, both change what is left to
    // do — and a snapshot would go on requesting a body that is already resolved while
    // missing one that is not.
    //
    // Skipping what this walk has already asked for is the other half of that: the board
    // is the right source for what is unloaded and cannot know which of those this walk
    // has had a turn at, since a key whose load rejected is unloaded again and looks
    // exactly like one that has never been asked for.
    const nextKey = this.#board
      .unloadedKeys()
      .find((candidateKey) => !this.#attemptedKeys.has(candidateKey));
    if (nextKey === undefined) {
      this.#scheduledHandle = undefined;
      return;
    }
    // Marked at ARM time rather than after the preload, so a key is never armed twice —
    // the walk re-arms synchronously beside the fetch it just started, and a mark that
    // waited for the load to settle would be written after the step that reads it.
    this.#attemptedKeys.add(nextKey);
    this.#scheduledHandle = this.#scheduler.schedule(() => {
      this.#scheduledHandle = undefined;
      this.#warmThenContinue(nextKey);
    });
  }

  #warmThenContinue(key: TKey): void {
    if (this.#isCancelled) {
      return;
    }
    // The preload's own rejection is deliberately swallowed HERE and nowhere else. A
    // chunk that will not load is a damaged install, and this walk is speculative — the
    // person has not asked for this pane — so the honest place for that failure is the
    // mount, where someone is waiting for it and the surface error boundary can say so.
    // An unhandled rejection from a background warm would surface as a crash report for
    // a pane nobody opened.
    void this.#board.preload(key).catch(() => undefined);
    // Armed immediately rather than after the load settles: the fetch is the browser's
    // to schedule, and waiting for it would serialise the walk behind the slowest chunk.
    // What stops the next step re-selecting this key is the attempted set and not the
    // board's memo: the memo is written synchronously by `preload` and released again if
    // that load rejects, so it answers "in flight or loaded" and not "already asked for".
    this.#armNextStep();
  }
}
