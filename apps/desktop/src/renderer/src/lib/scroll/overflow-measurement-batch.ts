// Batches re-measurement of clamped rows: several triggers in one frame (container resize,
// webfont swap, an explicit request) run the pass once, in a clock frame rather than a
// microtask so the pass reads settled layout.
//
// Carries no domain type: the scroll chokepoint imports this module, so importing its
// vocabulary back would be a cycle. The pass is a `() => void` the caller closes over.

import { type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";

/** Dependencies of an `OverflowMeasurementBatch`: the clock and the callbacks it drives. */
export interface OverflowMeasurementBatchOptions {
  readonly clock: Clock;
  /** Run once per batched frame. Composed by the caller, opaque here. */
  readonly runPass: () => void;
  /**
   * Runs synchronously on each resize observation, before the frame is armed.
   *
   * Re-measuring clamped rows may coalesce, but publishing the box may not: it is the only
   * way the viewport height reaches the library's rect, and a manual clock never runs a frame
   * unless told to, so a publication waiting on one would never arrive. A read and a notify
   * only, and a publication of an unchanged box wakes nobody.
   */
  readonly publishOnResize: () => void;
}

/** Coalesces every trigger inside one frame into a single overflow re-measurement pass. */
export class OverflowMeasurementBatch {
  readonly #clock: Clock;
  readonly #runPass: () => void;
  readonly #publishOnResize: () => void;

  #resizeObserver: ResizeObserver | undefined;
  #armedFrame: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: OverflowMeasurementBatchOptions) {
    this.#clock = options.clock;
    this.#runPass = options.runPass;
    this.#publishOnResize = options.publishOnResize;
  }

  /** Asks for a pass; every request inside one frame costs one pass. */
  public request(): void {
    if (this.#disposed || this.#armedFrame !== undefined) {
      return;
    }
    this.#armedFrame = this.#clock.scheduleFrame(() => {
      this.#armedFrame = undefined;
      this.#runPass();
    });
  }

  /** Re-runs the pass whenever the observed element resizes. */
  public observeResize(element: Element): void {
    if (this.#disposed) {
      return;
    }
    const observer = new ResizeObserver(() => {
      // Publish first, then arm: the window ranges against the publication, so it must not
      // wait on a frame.
      this.#publishOnResize();
      this.request();
    });
    observer.observe(element);
    this.#resizeObserver = observer;
  }

  /** Re-runs the pass once the webfonts have swapped; a clamped row's height depends on them. */
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
   * Stops observing and cancels a frame that has not run. Repeatable and null-safe: it runs on
   * an unmount that may follow a failed attach.
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

/**
 * The part of `document.fonts` this module uses; declared optional because the unit tier's DOM
 * shim has no font set.
 */
interface FontLoadingDocument {
  readonly fonts?: { readonly ready: Promise<unknown> };
}
