// The option object the virtualizer is constructed with: each way the library reaches the
// outside world, pointed at machinery this frame already has.
//
// Every member is a stable reference, because the virtualizer memoizes measurements against
// option identity and a closure rebuilt per render would recompute every offset. The exceptions
// are the key and the range extractor, replaced when the rows, the held rows or the drawn band
// change: the library's memos of the layout and of which rows it draws are keyed on them. No member
// reads an element: offset and rect come from one geometry sample, so following takes no hit test
// per scroll event. Every offset the library writes reaches the scroll chokepoint through
// `scrollToFn`, named for whoever it is made for. While a land is on its way the rows are drawn at
// the offset it ends at, not the one the box stands at, and a band narrowed for it keeps the
// rows already drawn near it rather than taking them down to draw them again. A follower's tail
// growing with arriving text is eased after rather than jumped to; every other write is placed at
// once.

import type { Range, Rect, Virtualizer } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import {
  TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
  TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS,
} from "./caps.js";
import { type DrawnBandScreenHeights } from "./drawn-band.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { prefersReducedMotion } from "#renderer/lib/reduced-motion.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollCaller } from "#renderer/lib/scroll/callers.js";
import { type GlideMotion } from "#renderer/lib/scroll/eased-glide.js";
import { SCROLL_TAIL_TOLERANCE_PX } from "#renderer/lib/scroll/geometry/publisher.js";
import { SCROLL_GEOMETRY_EPSILON_PX } from "#renderer/lib/scroll/geometry/sample.js";
import { widenRangeByPixels } from "#renderer/lib/scroll/item-band.js";
import { MOTION_DURATIONS_MS, settleEasingAt } from "#renderer/styles/motion.js";

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
  /** Whether the row at an index draws text that is still arriving. */
  readonly isRowRevealing: (index: number) => boolean;
  /** The indexes of the rows the reader holds that the window keeps, in any order. */
  readonly heldRowIndexes: () => readonly number[];
  /** The virtualizer built with these options, once it is bound. */
  readonly virtualizer: () => TranscriptRowVirtualizer | undefined;
  /**
   * The offset a land on its way ends at, over the rows as the library lays them out, or
   * `undefined` with none on its way.
   */
  readonly landingTargetPx: () => number | undefined;
  /** How far beyond each edge of the viewport the rows are drawn now, in screen heights. */
  readonly drawnBandScreenHeights: () => DrawnBandScreenHeights;
}

/** The stable option members the transcript's virtualizer is constructed with. */
export class VirtualizerOptions {
  readonly #scroll: ScrollController;
  readonly #measurements: RowMeasurementTable;
  readonly #virtualKeyAt: (index: number) => string | undefined;
  readonly #isFollowing: () => boolean;
  readonly #isRowRevealing: (index: number) => boolean;
  readonly #heldRowIndexes: () => readonly number[];
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;
  readonly #landingTargetPx: () => number | undefined;
  readonly #drawnBandScreenHeights: () => DrawnBandScreenHeights;

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
  /** The current identity of `rangeExtractor`, replaced by `redrawBand` and `rekeyRows`. */
  #rangeExtractor = (range: Range): number[] => this.#drawnIndexesOf(range);
  /** The current identity of `getItemKey`, replaced by `rekeyRows`. */
  #getItemKey = (index: number): string => this.#keyAt(index);
  /** The size the library laid a row out at, or the estimate it would lay the row out at. */
  readonly #laidOutSizeOf = (index: number): number =>
    this.#virtualizer()?.measurementsCache[index]?.size ?? this.estimateSize(index);
  /** The keys of the rows the last call of `rangeExtractor` drew. */
  #drawnRowKeys: ReadonlySet<string> = new Set();
  /** The row the library last measured, whose size change its next adjustment answers. */
  #measuredIndex: number | undefined;

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
   * adds it too. A re-aim of a retired scroll is not made, and a follower's tail growing with
   * arriving text is eased after instead.
   */
  public readonly scrollToFn = (
    offset: number,
    writeOptions: { adjustments?: number | undefined; behavior?: ScrollBehavior | undefined },
  ): void => {
    const caller = this.#callerOf(writeOptions);
    if (caller === undefined) {
      return;
    }
    if (caller === "follow-tail" && this.#jumpCaller === undefined) {
      if (this.#easesArrivingText(writeOptions.adjustments !== undefined)) {
        return;
      }
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
    this.#measuredIndex = index;
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
    this.#isRowRevealing = options.isRowRevealing;
    this.#heldRowIndexes = options.heldRowIndexes;
    this.#virtualizer = options.virtualizer;
    this.#landingTargetPx = options.landingTargetPx;
    this.#drawnBandScreenHeights = options.drawnBandScreenHeights;
  }

  /**
   * The rows the library draws: the ones the box intersects, or would at the offset a land on its
   * way ends at, beyond each end the rows within the drawn band's share of the viewport's own
   * height, counted from the end of that range and including the row that crosses the band's edge,
   * and every held row the window keeps, so the browser's selection stays anchored in the rows it
   * starts and ends in. While a land has narrowed the band, a row the last call drew stays drawn as
   * long as it is within the band's furthest reach, matched by key since a row joining at the head
   * moves every index: the narrowed band mounts no new row off screen, and takes down none it would
   * draw again as it widens. The library offers only a row count of its own, so the band is walked
   * in pixels here, over the sizes it laid the rows out at, or their estimates before it is bound.
   * The library re-asks only when the intersected range or this function's identity moves, so a
   * viewport that changed height without moving that range keeps its band until the next scroll.
   */
  public get rangeExtractor(): (range: Range) => number[] {
    return this.#rangeExtractor;
  }

  /**
   * Gives `rangeExtractor` a new identity, which the library's memo of the drawn rows keys on, so
   * the next render draws the band and the held rows as they now stand. Its other way to
   * recompute, `measure`, would also drop every measured height.
   */
  public redrawBand(): void {
    this.#rangeExtractor = (range: Range): number[] => this.#drawnIndexesOf(range);
  }

  /**
   * One row's key. The library lays the rows out again only when this identity or the row count
   * moves, so a key it already read is not read again until `rekeyRows` replaces the identity.
   */
  public get getItemKey(): (index: number) => string {
    return this.#getItemKey;
  }

  /**
   * Gives `getItemKey` and `rangeExtractor` new identities after the window's rows changed, so the
   * next render lays the rows out under their new keys and draws its band over their new sizes,
   * even when the row count and the intersected range did not move. Under the old identities the
   * library keeps the old keys, so its direct writes place each row at another row's start, and
   * keeps the band it walked over the old rows' sizes, held rows' indexes among them.
   */
  public rekeyRows(): void {
    this.#getItemKey = (index: number): string => this.#keyAt(index);
    this.#rangeExtractor = (range: Range): number[] => this.#drawnIndexesOf(range);
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
   * back. The library keeps re-aiming a scroll for up to five seconds and does not end one on a
   * gesture itself; `cancelScroll` ends it without a write.
   */
  public retireLibraryScroll(virtualizer: TranscriptRowVirtualizer): void {
    this.#reaimCaller = undefined;
    virtualizer.cancelScroll();
  }

  /** Points the options at the box the chokepoint just took, or at nothing. */
  public bindScrollContainer(scrollContainer: HTMLElement | undefined): void {
    this.#scrollContainer = scrollContainer;
  }

  /**
   * Eases a follower toward the tail when the write the library makes for it answers text arriving
   * in the log's last row: that row's own size change, or a row appended last, while it reveals.
   * Answers whether it eased; a write for any other row, under reduced motion or outside a frame
   * is placed at once. The tail is read each frame from the layout, so text landing mid-glide
   * re-aims it, and a reader who stops following ends it.
   */
  #easesArrivingText(isAdjustment: boolean): boolean {
    const virtualizer = this.#virtualizer();
    const ownerWindow = this.#scrollContainer?.ownerDocument.defaultView;
    if (virtualizer === undefined || ownerWindow === undefined || ownerWindow === null) {
      return false;
    }
    const lastIndex = virtualizer.options.count - 1;
    const grownIndex = isAdjustment ? this.#measuredIndex : lastIndex;
    if (
      lastIndex < 0 ||
      grownIndex !== lastIndex ||
      !this.#isRowRevealing(lastIndex) ||
      prefersReducedMotion(ownerWindow)
    ) {
      return false;
    }
    return this.#scroll.easeTo(
      "follow-arriving-text",
      (geometry) =>
        this.#isFollowing()
          ? Math.max(0, virtualizer.getTotalSize() - geometry.viewportHeight)
          : undefined,
      ARRIVING_TEXT_GLIDE,
    );
  }

  #keyAt(index: number): string {
    return this.#virtualKeyAt(index) ?? `row-without-a-key-${String(index)}`;
  }

  /**
   * The band around the intersected range, the rows a narrowed band keeps drawn, and the held rows
   * outside it, ascending.
   */
  #drawnIndexesOf(libraryRange: Range): number[] {
    const viewportHeightPx = this.#scroll.geometry?.viewportHeight ?? 0;
    const range = this.#landedRangeOf(libraryRange, viewportHeightPx);
    const bandScreenHeights = this.#drawnBandScreenHeights();
    const { startIndex, endIndex } = widenRangeByPixels(
      range,
      viewportHeightPx * bandScreenHeights.head,
      viewportHeightPx * bandScreenHeights.tail,
      this.#laidOutSizeOf,
    );
    const outsideIndexes = this.#heldRowIndexes().filter(
      (index) => (index < startIndex || index > endIndex) && index < range.count,
    );
    if (
      Math.min(bandScreenHeights.head, bandScreenHeights.tail) <
      TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS
    ) {
      const reachPx = viewportHeightPx * TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS;
      const reach = widenRangeByPixels(range, reachPx, reachPx, this.#laidOutSizeOf);
      for (let index = reach.startIndex; index <= reach.endIndex; index += 1) {
        if (
          (index < startIndex || index > endIndex) &&
          this.#drawnRowKeys.has(this.getItemKey(index)) &&
          !outsideIndexes.includes(index)
        ) {
          outsideIndexes.push(index);
        }
      }
    }
    const drawnIndexes = Array.from(
      { length: endIndex - startIndex + 1 },
      (_unused, offset) => startIndex + offset,
    );
    if (outsideIndexes.length > 0) {
      drawnIndexes.push(...outsideIndexes);
      // Ascending, so the rows are drawn in log order and a selection's range runs in reading
      // order.
      drawnIndexes.sort((left, right) => left - right);
    }
    this.#drawnRowKeys = new Set(drawnIndexes.map((index) => this.getItemKey(index)));
    return drawnIndexes;
  }

  /**
   * The rows the box intersects at the offset a land on its way ends at, so the render that lays
   * the land out mounts the rows the reader will see rather than the rows at the old offset; the
   * library's own range with no land on its way.
   */
  #landedRangeOf(libraryRange: Range, viewportHeightPx: number): Range {
    const targetPx = this.#landingTargetPx();
    const virtualizer = this.#virtualizer();
    if (targetPx === undefined || virtualizer === undefined) {
      return libraryRange;
    }
    const startIndex = virtualizer.getVirtualItemForOffset(targetPx)?.index;
    const endIndex = virtualizer.getVirtualItemForOffset(
      targetPx + Math.max(0, viewportHeightPx - SCROLL_GEOMETRY_EPSILON_PX),
    )?.index;
    return startIndex === undefined || endIndex === undefined
      ? libraryRange
      : { ...libraryRange, startIndex, endIndex };
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

/** How a follower is eased after arriving text: the settle duration and the settle curve. */
const ARRIVING_TEXT_GLIDE: GlideMotion = {
  durationMs: MOTION_DURATIONS_MS["motion-settle"],
  easing: settleEasingAt,
};
