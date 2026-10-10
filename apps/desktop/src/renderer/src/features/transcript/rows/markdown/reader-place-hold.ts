// The reader's place held through items a window nested in a conversation row resizes above the
// scroller's top. The conversation's own window holds the place for a row wholly above the top,
// but not for one the reader reads across, where an item drawn above the reader for the first time
// moves the text being read. A nested window adds each such item's change here, and the scroller
// moves once by their sum after the pass that measured them, before the frame paints: every item
// of one pass is judged against the offset the pass began at.

import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** One nested window's held changes, written through the conversation's scroll controller. */
export class ReaderPlaceHold {
  readonly #scrollController: ScrollController;
  /** The changes added since the last write, in CSS pixels. */
  #pendingPx = 0;
  #isWriteQueued = false;

  public constructor(scrollController: ScrollController) {
    this.#scrollController = scrollController;
  }

  /** Adds the change of an item above the scroller's top, written once this pass ends. */
  public add(deltaPx: number): void {
    this.#pendingPx += deltaPx;
    if (!this.#isWriteQueued) {
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
