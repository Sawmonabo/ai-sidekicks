// The option object the virtualizer is constructed with: each way the library reaches the
// outside world, pointed at machinery this frame already has.
//
// Every member is a stable reference, because the virtualizer memoizes measurements against
// option identity and a closure rebuilt per render would recompute every offset. No member reads
// an element: offset and rect come from one geometry sample, so following takes no hit test per
// scroll event.

import type { Rect, Virtualizer } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import { TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX } from "./constants.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollCaller } from "#renderer/lib/scroll/scroll-callers.js";

/** The virtualizer this frame drives, at the two element types it drives it with. */
export type TranscriptRowVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/**
 * What `VirtualizerOptions` reads from: the scroll chokepoint, the measurement table and the key
 * lookup.
 */
export interface VirtualizerOptionsInputs {
  readonly scroll: ScrollController;
  readonly measurements: RowMeasurementTable;
  /** The distinct key the measurement table projected for a row index. */
  readonly virtualKeyAt: (index: number) => string | undefined;
}

/** The stable option members the transcript's virtualizer is constructed with. */
export class VirtualizerOptions {
  readonly #scroll: ScrollController;
  readonly #measurements: RowMeasurementTable;
  readonly #virtualKeyAt: (index: number) => string | undefined;

  #scrollContainer: HTMLElement | undefined;
  /** Whom the library's writes are made for while a jump runs; otherwise they compensate. */
  #jumpCaller: ScrollCaller | undefined;

  /** The scroll container the library and the chokepoint both address. */
  public readonly getScrollElement = (): HTMLElement | null => this.#scrollContainer ?? null;

  /**
   * Every offset the library would write, performed by the one scroll writer and named for the
   * jump that asked for it, or as measurement compensation. `adjustments` is the library's
   * compensation for a measurement above the fold; the default adds it too.
   */
  public readonly scrollToFn = (
    offset: number,
    options: { adjustments?: number | undefined },
  ): void => {
    this.#scroll.glideTo(
      this.#jumpCaller ?? "measurement-compensation",
      offset + (options.adjustments ?? 0),
    );
  };

  /** The library's scroll offset, resent from the chokepoint's own sample. */
  public readonly observeElementOffset = (
    _instance: TranscriptRowVirtualizer,
    sink: (offset: number, isScrolling: boolean) => void,
  ): Unsubscribe =>
    this.#scroll.subscribeToGeometry((geometry) => {
      // Never `isScrolling`: it arms the library's debounce and scroll-end timers, and an idle
      // frame arms no timers.
      sink(geometry.scrollTop, false);
    });

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

  public readonly estimateSize = (): number => TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX;

  /** The measurement table's verdict on an observed row height. */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: TranscriptRowVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const rowKey = String(instance.options.getItemKey(index));
    return this.#measurements.acceptedHeight(rowKey, observedHeightOf(element, entry));
  };

  public constructor(options: VirtualizerOptionsInputs) {
    this.#scroll = options.scroll;
    this.#measurements = options.measurements;
    this.#virtualKeyAt = options.virtualKeyAt;
  }

  /**
   * Run a library scroll for `caller`, so the write it makes synchronously is recorded as that
   * caller's and two writers in one frame can be told apart.
   */
  public scrollFor(caller: ScrollCaller, scroll: () => void): void {
    this.#jumpCaller = caller;
    try {
      scroll();
    } finally {
      this.#jumpCaller = undefined;
    }
  }

  /** Points the options at the box the chokepoint just took, or at nothing. */
  public bindScrollContainer(scrollContainer: HTMLElement | undefined): void {
    this.#scrollContainer = scrollContainer;
  }
}

/**
 * The observed height, preferring the observer's border box over `offsetHeight`, which forces
 * layout.
 */
function observedHeightOf(element: HTMLElement, entry: ResizeObserverEntry | undefined): number {
  const borderBox = entry?.borderBoxSize?.[0];
  return borderBox === undefined ? element.offsetHeight : borderBox.blockSize;
}
