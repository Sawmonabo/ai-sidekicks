// The option object the virtualizer is constructed with, and nothing else.
//
// `Spec-023 §Console Libraries` adopts `@tanstack/react-virtual` because it is "the
// only candidate whose scroller we own (`getScrollElement`, `scrollToFn`,
// `observeElementOffset`)". This module is that ownership, stated once: every way
// the library can reach the outside world, pointed back at machinery this frame
// already has. Each default it replaces is named beside it, because what the default
// would have done is the reason the override exists.
//
// Two properties hold across the whole set. Every member is a STABLE reference: the
// virtualizer re-reads its options on every render and memoizes its measurements
// against their identity, so a closure rebuilt per render recomputes every offset in
// the window on a render that changed nothing. And no member reads an element: the
// offset and the rect both come from one already-taken geometry sample, which is
// what lets `scroll-chokepoint.ts`'s "no hit test per scroll event while following"
// hold with no special case.

import type { Rect, Virtualizer } from "@tanstack/react-virtual";

import { type Unsubscribe } from "../../../core/index.js";
import { LEDGER_ROW_HEIGHT_ESTIMATE_PX } from "../frame-bounds.js";
import { RowMeasurementLedger } from "../measurement/index.js";
import { LedgerScrollController, type LedgerScrollSurface } from "../scroll/index.js";

/** The virtualizer this frame drives, at the two element types it drives it with. */
export type LedgerRowVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

export interface LedgerVirtualizerSeamsOptions {
  readonly scroll: LedgerScrollController;
  readonly measurements: RowMeasurementLedger;
  /** The distinct key the measurement ledger projected for a row index. */
  readonly virtualKeyAt: (index: number) => string | undefined;
}

export class LedgerVirtualizerSeams {
  readonly #scroll: LedgerScrollController;
  readonly #measurements: RowMeasurementLedger;
  readonly #virtualKeyAt: (index: number) => string | undefined;

  #surface: HTMLElement | undefined;

  public constructor(options: LedgerVirtualizerSeamsOptions) {
    this.#scroll = options.scroll;
    this.#measurements = options.measurements;
    this.#virtualKeyAt = options.virtualKeyAt;
  }

  /**
   * Point the seams at the box the chokepoint just took, or at nothing.
   *
   * Only an `HTMLElement` can be handed to the library; a structural surface driven
   * by a test leaves the library detached, which is the honest state rather than a
   * stand-in element it would try to observe.
   */
  public bindSurface(surface: LedgerScrollSurface | undefined): void {
    this.#surface = surface instanceof HTMLElement ? surface : undefined;
  }

  /** The surface the library and the chokepoint both address. */
  public readonly getScrollElement = (): HTMLElement | null => this.#surface ?? null;

  /**
   * Every offset the library would write, performed by the one writer.
   *
   * `adjustments` is the library's own compensation for a measurement that landed
   * above the fold; it is added here because the default implementation adds it too,
   * and dropping it would leave the library believing it had moved an offset it had
   * not.
   */
  public readonly scrollToFn = (
    offset: number,
    options: { adjustments?: number | undefined },
  ): void => {
    this.#scroll.glideTo("measurement-compensation", offset + (options.adjustments ?? 0));
  };

  /** The library's scroll offset, replayed from the chokepoint's own sample. */
  public readonly observeElementOffset = (
    _instance: LedgerRowVirtualizer,
    sink: (offset: number, isScrolling: boolean) => void,
  ): Unsubscribe =>
    this.#scroll.subscribeToGeometry((geometry) => {
      // Never `isScrolling`: that flag exists to arm the library's own debounce and
      // scroll-end timers, and this frame's budget is zero timers while idle.
      sink(geometry.scrollTop, false);
    });

  /** The library's viewport rect, from the same sample. */
  public readonly observeElementRect = (
    _instance: LedgerRowVirtualizer,
    sink: (rect: Rect) => void,
  ): Unsubscribe =>
    this.#scroll.subscribeToGeometry((geometry) => {
      // The ledger is a vertical list and never sets `horizontal`, so the library
      // reads `height` and never `width`. Publishing a width the chokepoint does not
      // sample would be inventing a number to fill a field nobody reads.
      sink({ width: 0, height: geometry.viewportHeight });
    });

  /**
   * One row's key, and the height a row is assumed to have before it is measured.
   *
   * Both are stable references on purpose. The virtualizer re-reads its options on
   * every render and memoizes its measurements against their identity, so a closure
   * rebuilt per render invalidates that memo every render — which is a recomputation
   * of every offset in the window on a render that changed nothing.
   */
  public readonly getItemKey = (index: number): string =>
    this.#virtualKeyAt(index) ?? `row-without-a-key-${String(index)}`;

  public readonly estimateSize = (): number => LEDGER_ROW_HEIGHT_ESTIMATE_PX;

  /** The measurement ledger's verdict on an observed row height. */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: LedgerRowVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const rowKey = String(instance.options.getItemKey(index));
    return this.#measurements.acceptedHeight(rowKey, observedHeightOf(element, entry));
  };
}

/**
 * The height an observation reports, preferring the border box the observer already
 * measured over a layout read the browser has to answer.
 *
 * A `ResizeObserver` entry is the cheaper of the two by construction: it was
 * computed during layout, whereas `offsetHeight` forces one.
 */
function observedHeightOf(element: HTMLElement, entry: ResizeObserverEntry | undefined): number {
  const borderBox = entry?.borderBoxSize?.[0];
  return borderBox === undefined ? element.offsetHeight : borderBox.blockSize;
}
