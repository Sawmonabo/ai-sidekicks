// The history line above the transcript's first row: the list starts below it, so its height is
// where the rows start, and a change in it moves every row by as much. While the line stands
// wholly above the viewport the offset moves with the rows, so the reader's row stays where it
// stands on screen.

import { observeElementResize } from "#renderer/lib/element-resize.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import type { Unsubscribe } from "#shared/preload-api.js";

/** What the history line moves and tells. */
export interface ViewportHistoryLineOptions {
  readonly scroll: ScrollController;
  /** The line's height changed: the list's next render starts its rows below the new height. */
  readonly publish: () => void;
}

/** The history line's height above the first row, and the offset it moves as the line grows. */
export class ViewportHistoryLine {
  readonly #scroll: ScrollController;
  readonly #publish: () => void;
  /** The line's height above the first row, as the last resize observation read it. */
  #heightPx = 0;
  /**
   * The part of the line's last change the offset could not move by, and the offset it was left
   * at. The offset moves in device pixels and the line's height need not be whole, so the fraction
   * is moved with the next change, unless the offset has moved since, as a reader's scroll does.
   */
  #shiftOwed: { readonly px: number; readonly atScrollTopPx: number } | undefined;
  #disposed = false;

  public constructor(options: ViewportHistoryLineOptions) {
    this.#scroll = options.scroll;
    this.#publish = options.publish;
  }

  /** The line's height above the first row, in pixels, where the list starts. */
  public get heightPx(): number {
    return this.#heightPx;
  }

  /**
   * Follows the height of the line's box `head` until the returned call. The observation lands
   * after layout and before paint, so the moved rows are never drawn.
   */
  public attach(head: HTMLElement): Unsubscribe {
    const stopObserving = observeElementResize(head, (entries) => {
      const heightPx = entries[0]?.borderBoxSize[0]?.blockSize;
      if (heightPx !== undefined) {
        this.#takeHeight(heightPx);
      }
    });
    return () => {
      stopObserving();
      this.#takeHeight(0);
    };
  }

  /** Terminal: no height is taken after it. */
  public dispose(): void {
    this.#disposed = true;
  }

  /**
   * Tells the list where its rows start and, while the line stands wholly above the viewport,
   * moves the offset by what the line grew. A line in view, as at the top of the log and at mount,
   * lets the rows flow below it instead, so its own head is never pushed out of sight.
   */
  #takeHeight(heightPx: number): void {
    const previousHeightPx = this.#heightPx;
    const grownPx = heightPx - previousHeightPx;
    if (this.#disposed || grownPx === 0) {
      return;
    }
    this.#heightPx = heightPx;
    const owed = this.#shiftOwed;
    this.#shiftOwed = undefined;
    const scrollTopPx = this.#scroll.geometry?.scrollTop;
    if (scrollTopPx !== undefined && scrollTopPx > 0 && scrollTopPx >= previousHeightPx) {
      const owedPx = owed?.atScrollTopPx === scrollTopPx ? owed.px : 0;
      const write = this.#scroll.glideTo("hold-reading-position", scrollTopPx + owedPx + grownPx);
      // `glideTo` has already clamped its target to the content, so what the platform left unmoved
      // is its rounding to a device pixel, which is owed; a pixel or more can only be its own clamp
      // at the content's end, which owes nothing.
      const unmovedPx = write === undefined ? 0 : write.requestedScrollTop - write.appliedScrollTop;
      if (write !== undefined && Math.abs(unmovedPx) < 1) {
        this.#shiftOwed = { px: unmovedPx, atScrollTopPx: write.appliedScrollTop };
      }
    }
    this.#publish();
  }
}
