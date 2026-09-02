// Triggers accumulate; one pre-paint frame runs the pass. Nothing here knows what
// the pass measures.
//
// The ledger clamps rows, and a clamped row's real height is knowable only after
// layout. Three unrelated things want that re-measured — the surface resized, a
// webfont swapped, a caller asked outright — and each can fire several times in one
// frame. Running the pass per trigger reads a layout the browser has not settled
// and pays for the read once per trigger; this batch turns all three into one pass.
//
// WHY IT IS ITS OWN MODULE rather than three private methods on the scroll
// controller. Two reasons, and the second is structural:
//
//   • Batching is not scrolling. A scroll fires none of these triggers, so the
//     arming, the single-frame coalescing, and the cancellation are one idea that
//     none of the chokepoint's four decisions contains.
//   • It carries NO domain type. The geometry and the surface are the chokepoint's
//     vocabulary and the chokepoint imports this module, so an import back would be
//     the cycle the layering gate refuses. What the pass does is a `() => void` the
//     caller closes over, and the observed subject is narrowed to an element here —
//     which is the whole of what this module ever needed to know.
//
// The frame comes from the clock seam rather than from a microtask, so the pass
// reads a layout the browser has settled rather than one it is still computing.

import { type ConsoleClock, type ScheduledHandle } from "../../core/index.js";

/**
 * Fonts, as much of the API as this module uses.
 *
 * Declared rather than reached through `document.fonts` typing, because the console
 * runs under a DOM shim in the unit tier where the set is absent, and an optional
 * declaration is the honest statement of that.
 */
interface FontLoadingDocument {
  readonly fonts?: { readonly ready: Promise<unknown> };
}

export interface OverflowMeasurementBatchOptions {
  readonly clock: ConsoleClock;
  /** Run once per batched frame. Composed by the caller, opaque here. */
  readonly runPass: () => void;
}

export class OverflowMeasurementBatch {
  readonly #clock: ConsoleClock;
  readonly #runPass: () => void;

  #resizeObserver: ResizeObserver | undefined;
  #armedFrame: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: OverflowMeasurementBatchOptions) {
    this.#clock = options.clock;
    this.#runPass = options.runPass;
  }

  /**
   * Ask for a pass. Every request inside one frame costs one pass.
   *
   * The armed handle IS the accumulator: a second request while one is armed is
   * already represented by the frame that is coming.
   */
  public request(): void {
    if (this.#disposed || this.#armedFrame !== undefined) {
      return;
    }
    this.#armedFrame = this.#clock.scheduleFrame(() => {
      this.#armedFrame = undefined;
      this.#runPass();
    });
  }

  /**
   * Re-run the pass whenever the observed subject resizes.
   *
   * Typed as `object` rather than as the caller's surface: this module has no
   * business knowing what a scroll surface is, and the only property it needs is
   * the one the narrowing below establishes — that the subject happens to be an
   * element the platform can observe. A subject that is not one, which is what a
   * unit tier drives, is skipped rather than handed to an observer that could never
   * feed it.
   */
  public observeResize(candidate: object): void {
    if (this.#disposed || !(candidate instanceof Element)) {
      return;
    }
    const observerHost = globalThis as { readonly ResizeObserver?: typeof ResizeObserver };
    const ObserverConstructor = observerHost.ResizeObserver;
    if (ObserverConstructor === undefined) {
      // A DOM shim without a resize observer. The pass still runs on font loading
      // and on the caller's own explicit requests, so the absence costs a trigger
      // rather than the feature.
      return;
    }
    const observer = new ObserverConstructor(() => {
      this.request();
    });
    observer.observe(candidate);
    this.#resizeObserver = observer;
  }

  /**
   * Re-run the pass once the webfonts have swapped.
   *
   * A clamped row's height is a function of its font, so every measurement taken
   * before the swap describes a layout that no longer exists.
   */
  public observeFontLoading(): void {
    const fonts = (globalThis as { readonly document?: FontLoadingDocument }).document?.fonts;
    if (fonts === undefined) {
      return;
    }
    void fonts.ready.then(() => {
      this.request();
    });
  }

  /**
   * Stop observing, and cancel a frame that has not run.
   *
   * Every read is null-safe and the whole method is repeatable: release runs on an
   * unmount that may follow a failed attach, so the observer and the armed frame
   * may each be absent independently.
   */
  public release(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    if (this.#armedFrame !== undefined) {
      this.#clock.cancel(this.#armedFrame);
      this.#armedFrame = undefined;
    }
  }

  /** Terminal. A disposed batch observes nothing and arms nothing. */
  public dispose(): void {
    this.release();
    this.#disposed = true;
  }
}
