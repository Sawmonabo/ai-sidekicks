// The members a window nested in a conversation row is built with to lay its items out against the
// conversation scroller: a long body's window over its blocks and a long table's over its rows.
// Its offset is the scroller's less the window's top in the scroller's content, taken from the
// scroll controller's published geometry, so following a scroll reads no element. Its top is read
// when the offset is sent, never handed to the library as a scroll margin: a changed margin makes
// the library lay every item out again. The library never writes the scroller for the window: a
// window that holds the reader's place through an item it resized does so through
// `ReaderPlaceHold`, and the conversation's own window holds it for every other change.

import type { Range, Rect } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { widenRangeByPixels } from "#renderer/lib/scroll/item-band.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { type DrawnBandScreenHeights } from "../../viewport/drawn-band.js";

/** The scroller-facing members of one nested window, read through `topPx` for its place. */
export class ScrollerWindowMembers {
  readonly #scrollController: ScrollController;
  readonly #topPx: () => number;
  /** Sends the window the offset again, for a window whose top moved under an unmoved scroller. */
  #resendOffset: (() => void) | undefined;

  /** The window's writes, made by no one: a nested window never moves the conversation. */
  public readonly scrollToFn = (): void => {
    // The conversation's own window holds the reader's place; a nested one writing it would fight.
  };

  /** The window's offset: the scroller's, less the window's top in the scroller's content. */
  public readonly observeElementOffset = (
    _instance: unknown,
    sink: (offset: number, isScrolling: boolean) => void,
  ): Unsubscribe => {
    const sendOffset = (): void => {
      const geometry = this.#scrollController.geometry;
      if (geometry !== undefined) {
        // Never `isScrolling`: it arms the library's scroll-end timers, which no window needs.
        sink(geometry.scrollTop - this.#topPx(), false);
      }
    };
    const unsubscribe = this.#scrollController.subscribeToGeometry(sendOffset);
    this.#resendOffset = sendOffset;
    return () => {
      unsubscribe();
      this.#resendOffset = undefined;
    };
  };

  /** The window's viewport: the scroller's own height, from the same geometry. */
  public readonly observeElementRect = (
    _instance: unknown,
    sink: (rect: Rect) => void,
  ): Unsubscribe =>
    this.#scrollController.subscribeToGeometry((geometry) => {
      // A vertical list: the library reads `height` and never `width`, which is not sampled.
      sink({ width: 0, height: geometry.viewportHeight });
    });

  /** Where the window opens before its first geometry sample: the scroller's offset now. */
  public readonly initialOffset = (): number => {
    const geometry = this.#scrollController.geometry;
    return geometry === undefined ? 0 : geometry.scrollTop - this.#topPx();
  };

  /** `topPx` reads the window's top in the scroller's content, in CSS pixels, when called. */
  public constructor(scrollController: ScrollController, topPx: () => number) {
    this.#scrollController = scrollController;
    this.#topPx = topPx;
  }

  /** The viewport the window opens against before its first geometry sample. */
  public initialRect(): Rect {
    return { width: 0, height: this.#scrollController.geometry?.viewportHeight ?? 0 };
  }

  /**
   * The items the window draws for the library's `range`: those the scroller shows and those within
   * `bandScreenHeights` past each edge, reached in the scroller's own height, ascending.
   * `sizeAtPx` answers an item's laid-out size, measured or estimated.
   */
  public drawnIndexesOf(
    range: Range,
    bandScreenHeights: DrawnBandScreenHeights,
    sizeAtPx: (index: number) => number,
  ): number[] {
    const viewportHeightPx = this.#scrollController.geometry?.viewportHeight ?? 0;
    const { startIndex, endIndex } = widenRangeByPixels(
      range,
      viewportHeightPx * bandScreenHeights.head,
      viewportHeightPx * bandScreenHeights.tail,
      sizeAtPx,
    );
    return Array.from(
      { length: endIndex - startIndex + 1 },
      (_unused, offset) => startIndex + offset,
    );
  }

  /** Sends the window its offset again, after its top moved while the scroller did not. */
  public resendOffset(): void {
    this.#resendOffset?.();
  }
}

/** The library's compensation for a resized item, refused: a nested window follows, never moves. */
export function refuseScrollAdjustment(): boolean {
  return false;
}

/** How far a body's top sits below its conversation row's, in CSS pixels; laying both out. */
export function offsetInRowPx(body: Element): number {
  const row = body.closest(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`);
  return row === null ? 0 : body.getBoundingClientRect().top - row.getBoundingClientRect().top;
}
