// The reader's place held through items a window nested in a conversation row resizes above the
// scroller's top. The conversation's own window holds the place for a row wholly above the top,
// but not for one the reader reads across, where an item drawn above the reader for the first time
// moves the text being read. A nested window adds each such item's change here, and the scroller
// moves once by their sum after the pass that measured them, before the frame paints: every item
// of one pass is judged where it stood as the pass began, against the offset the pass began at.
// Heights measured off screen are drawn only in a later commit, so their sum waits for it.

import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** One nested window's held changes, written through the conversation's scroll controller. */
export class ReaderPlaceHold {
  readonly #scrollController: ScrollController;
  /** The changes added since the last write, in CSS pixels. */
  #pendingPx = 0;
  #isWriteQueued = false;
  #isWriteDeferred = false;

  public constructor(scrollController: ScrollController) {
    this.#scrollController = scrollController;
  }

  /**
   * Holds the place through an item that resized by `deltaPx`, if it stood wholly above the
   * scroller's top as the pass began: its end, less the changes held this pass above it, at or
   * above the window's `scrollOffsetPx`.
   */
  public holdThroughResizedItem(itemEndPx: number, deltaPx: number, scrollOffsetPx: number): void {
    if (itemEndPx <= scrollOffsetPx + this.#pendingPx) {
      this.add(deltaPx);
    }
  }

  /** Adds the change of an item above the scroller's top, written once this pass ends. */
  public add(deltaPx: number): void {
    this.#pendingPx += deltaPx;
    this.#queueWrite();
  }

  /**
   * Holds every change added from now until `releaseWrite`: for items whose new room the page
   * draws only in a later commit, which a write before it would run past.
   */
  public deferWrite(): void {
    this.#isWriteDeferred = true;
  }

  /** Writes the changes held since `deferWrite` once this pass ends; nothing when none is held. */
  public releaseWrite(): void {
    if (this.#isWriteDeferred) {
      this.#isWriteDeferred = false;
      this.#queueWrite();
    }
  }

  #queueWrite(): void {
    if (!this.#isWriteQueued && !this.#isWriteDeferred && this.#pendingPx !== 0) {
      this.#isWriteQueued = true;
      queueMicrotask(() => {
        this.#write();
      });
    }
  }

  #write(): void {
    const pendingPx = this.#pendingPx;
    this.#pendingPx = 0;
    this.#isWriteQueued = false;
    const geometry = this.#scrollController.geometry;
    if (geometry !== undefined && pendingPx !== 0) {
      this.#scrollController.glideTo("measurement-compensation", geometry.scrollTop + pendingPx);
    }
  }
}
