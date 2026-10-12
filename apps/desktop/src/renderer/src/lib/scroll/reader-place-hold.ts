// The reader's place held through items a window nested in a conversation row resizes above the
// scroller's top. The conversation's own window holds the place for a row wholly above the top,
// but not for one the reader reads across, where an item drawn above the reader for the first time
// moves the text being read. A nested window adds each such item's change here, and the scroller
// moves once by their sum after the pass that measured them, before the frame paints: every item
// of one pass is judged where it stood as the pass began, against the offset the pass began at.
// Heights measured off screen are drawn only in a later commit, so their sum waits for it. A new
// width or text size lays every item out anew at once, where no item's place as the pass began
// is left to judge it by, so the item the reader reads in is held instead: its start stays put.

import type { VirtualItem } from "@tanstack/virtual-core";

import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";

/** What a hold reads of a window's whole layout: a virtualizer's own members. */
export interface ReaderPlaceLayout {
  /** The reader's offset in the window, from its top. */
  readonly scrollOffset: number | null;
  readonly measurementsCache: readonly VirtualItem[];
  readonly getTotalSize: () => number;
  readonly getVirtualItemForOffset: (offsetPx: number) => VirtualItem | undefined;
}

/** One nested window's held changes, written through the conversation's scroll controller. */
export class ReaderPlaceHold {
  readonly #scrollController: ScrollController;
  /** The changes added since the last write, in CSS pixels. */
  #pendingPx = 0;
  #isWriteQueued = false;
  #isWriteDeferred = false;
  /** Whether a whole layout is being laid out anew, whose items' changes the relayout holds. */
  #isRelayingOut = false;

  public constructor(scrollController: ScrollController) {
    this.#scrollController = scrollController;
  }

  /**
   * Holds the place through an item that resized by `deltaPx`, if it stood wholly above the
   * scroller's top as the pass began: its end, less the changes held this pass above it, at or
   * above the window's `scrollOffsetPx`.
   */
  public holdThroughResizedItem(itemEndPx: number, deltaPx: number, scrollOffsetPx: number): void {
    if (!this.#isRelayingOut && itemEndPx <= scrollOffsetPx + this.#pendingPx) {
      this.add(deltaPx);
    }
  }

  /**
   * Lays `layout` out anew through `relayOut` and, when `holdsPlace`, holds the item the reader's
   * offset falls in where it started before, or the items' end for a reader past them: every
   * item above it, drawn or not, moves the conversation by its change. A reader above the window
   * is not moved. Each item `relayOut` resizes is held through the relayout alone.
   */
  public holdThroughRelayout(
    layout: ReaderPlaceLayout,
    holdsPlace: boolean,
    relayOut: () => void,
  ): void {
    const place = placeAt(layout, layout.scrollOffset ?? 0);
    this.#isRelayingOut = true;
    try {
      relayOut();
    } finally {
      this.#isRelayingOut = false;
    }
    if (holdsPlace && place !== undefined) {
      this.add(startOfPlace(layout, place) - place.startPx);
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

/** Where a reader stands in a layout: the item its offset falls in, or past the last item. */
interface ReaderPlace {
  readonly index: number | undefined;
  readonly startPx: number;
}

/**
 * Where the reader stands in `layout` at `offsetPx` from its top: the item the offset falls in and
 * its start, or past the last item and the items' end; `undefined` above the layout.
 */
function placeAt(layout: ReaderPlaceLayout, offsetPx: number): ReaderPlace | undefined {
  const endPx = layout.getTotalSize();
  if (offsetPx <= 0 || endPx === 0) {
    return undefined;
  }
  if (offsetPx >= endPx) {
    return { index: undefined, startPx: endPx };
  }
  const item = layout.getVirtualItemForOffset(offsetPx);
  return item === undefined ? undefined : { index: item.index, startPx: item.start };
}

/** Where `place`'s item starts in `layout` as it is laid out now, or the items' end past them. */
function startOfPlace(layout: ReaderPlaceLayout, place: ReaderPlace): number {
  const endPx = layout.getTotalSize();
  return place.index === undefined
    ? endPx
    : (layout.measurementsCache[place.index]?.start ?? endPx);
}
