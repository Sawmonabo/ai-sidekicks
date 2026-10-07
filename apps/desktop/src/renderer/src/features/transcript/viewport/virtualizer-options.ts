// The option object the virtualizer is constructed with: each way the library reaches the
// outside world, pointed at machinery this frame already has.
//
// Every member is a stable reference, because the virtualizer memoizes measurements against
// option identity and a closure rebuilt per render would recompute every offset. No member reads
// an element: offset and rect come from one geometry sample, so following takes no hit test per
// scroll event. Every offset the library writes reaches the scroll chokepoint through
// `scrollToFn`, named for whoever it is made for.

import type { Rect, Virtualizer } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollCaller } from "#renderer/lib/scroll/callers.js";
import { SCROLL_TAIL_TOLERANCE_PX } from "#renderer/lib/scroll/geometry/publisher.js";
import { SCROLL_GEOMETRY_EPSILON_PX } from "#renderer/lib/scroll/geometry/sample.js";

/** The virtualizer this frame drives, at the two element types it drives it with. */
export type TranscriptRowVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/**
 * What `VirtualizerOptions` reads from: the scroll chokepoint, the measurement table, the key
 * lookup, the reading state and the virtualizer these options were handed to.
 */
export interface VirtualizerOptionsInputs {
  readonly scroll: ScrollController;
  readonly measurements: RowMeasurementTable;
  /** The distinct key the measurement table projected for a row index. */
  readonly virtualKeyAt: (index: number) => string | undefined;
  /** Whether the reader follows the tail, read at each write the library makes. */
  readonly isFollowing: () => boolean;
  /** The virtualizer built with these options, once it is bound. */
  readonly virtualizer: () => TranscriptRowVirtualizer | undefined;
}

/** The stable option members the transcript's virtualizer is constructed with. */
export class VirtualizerOptions {
  readonly #scroll: ScrollController;
  readonly #measurements: RowMeasurementTable;
  readonly #virtualKeyAt: (index: number) => string | undefined;
  readonly #isFollowing: () => boolean;
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;

  #scrollContainer: HTMLElement | undefined;
  /** Whom the library's writes are made for while a jump runs. */
  #jumpCaller: ScrollCaller | undefined;
  /**
   * Whom the library's later re-aims of the last jump are made for, or `undefined` once that
   * scroll was retired and its writes are no longer anyone's.
   */
  #reaimCaller: ScrollCaller | undefined;
  /** Set when the library takes a box; its next write puts that box at the offset it holds. */
  #isOpeningBox = false;

  /**
   * How near its end, in pixels, the library counts the reader as at it: the reading anchor's
   * tail band, so a reader the anchor calls following is one the library follows on an append
   * and as rows measure.
   */
  public readonly scrollEndThreshold: number =
    SCROLL_TAIL_TOLERANCE_PX + SCROLL_GEOMETRY_EPSILON_PX;

  /** The scroll container the library and the chokepoint both address. */
  public readonly getScrollElement = (): HTMLElement | null => this.#scrollContainer ?? null;

  /**
   * Every offset the library would write, performed by the one scroll writer and named for whom it
   * is made. `adjustments` is the library's compensation for a row that changed size; the default
   * adds it too. A re-aim of a retired scroll is not made.
   */
  public readonly scrollToFn = (
    offset: number,
    writeOptions: { adjustments?: number | undefined; behavior?: ScrollBehavior | undefined },
  ): void => {
    const caller = this.#callerOf(writeOptions);
    if (caller === undefined) {
      return;
    }
    this.#scroll.glideTo(caller, offset + (writeOptions.adjustments ?? 0));
  };

  /** The library's scroll offset, resent from the chokepoint's own sample. */
  public readonly observeElementOffset = (
    _instance: TranscriptRowVirtualizer,
    sink: (offset: number, isScrolling: boolean) => void,
  ): Unsubscribe => {
    // The library subscribes here only as it takes a box, and its next write restates the offset
    // this subscription resends it.
    this.#isOpeningBox = true;
    return this.#scroll.subscribeToGeometry((geometry) => {
      // Never `isScrolling`: it arms the library's debounce and scroll-end timers, and an idle
      // frame arms no timers.
      sink(geometry.scrollTop, false);
    });
  };

  /** The library's viewport rect, from the same sample. */
  public readonly observeElementRect = (
    _instance: TranscriptRowVirtualizer,
    sink: (rect: Rect) => void,
  ): Unsubscribe =>
    this.#scroll.subscribeToGeometry((geometry) => {
      // A vertical list: the library reads `height` and never `width`, which is not sampled.
      sink({ width: 0, height: geometry.viewportHeight });
    });

  /** One row's key. Stable references: a closure rebuilt per render invalidates the memo. */
  public readonly getItemKey = (index: number): string =>
    this.#virtualKeyAt(index) ?? `row-without-a-key-${String(index)}`;

  /**
   * An unmeasured row's height: what the session remembers for it, or its kind's estimate.
   *
   * The library asks again on every rebuild, so an answer that changed while a reader reads would
   * move every row below it. A remembered height is therefore handed to the library as the size it
   * holds for the row, and stays its place when the session lets the height go (past its cap, at
   * a new width) until the row measures. A kind's estimate moves only where the measurement table
   * publishes it.
   */
  public readonly estimateSize = (index: number): number => {
    const measuredKey = this.getItemKey(index);
    const rememberedHeightPx = this.#measurements.rememberedHeightOf(measuredKey);
    if (rememberedHeightPx === undefined) {
      return this.#measurements.heightOf(measuredKey);
    }
    // Set as the library sets a measured size, without a rebuild: this one lays the row out at it.
    this.#virtualizer()?.itemSizeCache.set(measuredKey, rememberedHeightPx);
    return rememberedHeightPx;
  };

  /**
   * The measurement table's verdict on a row's observed border box, whose width is the width
   * every row is laid out at. With no observation, as a row mounts, it answers the size the
   * library already holds for the row and reads no element: the observer reports the row's real
   * size before the frame paints, and the library compensates for it then.
   */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: TranscriptRowVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const borderBox = entry?.borderBoxSize[0];
    if (borderBox === undefined) {
      return (
        instance.itemSizeCache.get(this.getItemKey(index)) ??
        instance.measurementsCache[index]?.size ??
        this.estimateSize(index)
      );
    }
    this.#measurements.declareRowWidth(borderBox.inlineSize);
    return this.#measurements.acceptedHeight(this.getItemKey(index), borderBox.blockSize);
  };

  public constructor(options: VirtualizerOptionsInputs) {
    this.#scroll = options.scroll;
    this.#measurements = options.measurements;
    this.#virtualKeyAt = options.virtualKeyAt;
    this.#isFollowing = options.isFollowing;
    this.#virtualizer = options.virtualizer;
  }

  /**
   * Run a library scroll for `caller`, so the write it makes now and each re-aim it makes over
   * later frames, as the rows around its target measure, are recorded as that caller's.
   */
  public scrollFor(caller: ScrollCaller, scroll: () => void): void {
    this.#jumpCaller = caller;
    this.#reaimCaller = caller;
    try {
      scroll();
    } finally {
      this.#jumpCaller = undefined;
    }
  }

  /**
   * Ends the library's running scroll where the reader is, for a reader who has taken the offset
   * back. The library keeps re-aiming a scroll for up to five seconds and nothing of its own
   * cancels one on a gesture; a new command replaces it, and this one's writes are not made.
   */
  public retireLibraryScroll(virtualizer: TranscriptRowVirtualizer): void {
    this.#reaimCaller = undefined;
    // A command of no distance: unlike `scrollToOffset`, it reads no element to clamp against.
    virtualizer.scrollBy(0);
  }

  /** Points the options at the box the chokepoint just took, or at nothing. */
  public bindScrollContainer(scrollContainer: HTMLElement | undefined): void {
    this.#scrollContainer = scrollContainer;
  }

  /**
   * Whom one library write is made for, from what the library is doing when it makes it, or
   * `undefined` for a re-aim of a retired scroll.
   */
  #callerOf(writeOptions: {
    adjustments?: number | undefined;
    behavior?: ScrollBehavior | undefined;
  }): ScrollCaller | undefined {
    if (this.#isOpeningBox) {
      this.#isOpeningBox = false;
      return "window-opening";
    }
    if (this.#jumpCaller !== undefined) {
      return this.#jumpCaller;
    }
    // A follower's offset is the library's to keep on the tail: its end anchor as rows measure,
    // its landing on an appended row, and a tail jump's re-aims once the reader follows again.
    if (this.#isFollowing()) {
      return "follow-tail";
    }
    // The library names a behavior, with no adjustment, only on a write a scroll command makes,
    // and while the reader reads that command was a jump's. Every other write is its
    // compensation for a row that measured above the fold, or the retry of one the box clamped.
    const isReaim = writeOptions.behavior !== undefined && writeOptions.adjustments === undefined;
    return isReaim ? this.#reaimCaller : "measurement-compensation";
  }
}
