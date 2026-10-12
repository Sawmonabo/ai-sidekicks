// The state behind a window nested in a conversation row whose items are blocks in flow, each as
// tall as the browser lays it out: a command output's chunks of lines and a diff's steps of rows.
// The window lays its items out against the conversation scroller through `ScrollerWindowMembers`,
// from the top of its element in the scroller's content, read from its row's top and the element's
// place in the row. A spacer holds the room of each run of undrawn items, estimated by the window's
// owner until each item is measured, drawn or off screen a slice at a time, so the spacers come to
// hold the items' real room before the reader scrolls to them.

import type { Range, VirtualItem, Virtualizer } from "@tanstack/virtual-core";

import { ReaderPlaceHold } from "#renderer/lib/scroll/reader-place-hold.js";
import { type DrawnBandScreenHeights } from "#renderer/lib/scroll/window-side.js";
import {
  OffScreenMeasurement,
  type OffScreenBox,
  type OffScreenItem,
  type OffScreenItemHeight,
} from "#renderer/lib/off-screen-measurement.js";
import { type TranscriptBodyViewport } from "./context.js";
import { ScrollerWindowMembers } from "./scroller-window.js";

/** The virtualizer a measured window runs, over its element and its drawn items. */
export type MeasuredItemVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/** One element of a measured window, in document order. */
export type MeasuredWindowRow =
  | { readonly kind: "item"; readonly key: string; readonly index: number }
  | {
      /** The room of a run of undrawn items, first to last, where flow would lay them out. */
      readonly kind: "spacer";
      readonly key: string;
      readonly heightPx: number;
      readonly firstIndex: number;
      readonly lastIndex: number;
    };

/** What a measured window lays out, read from its owner each time it is asked. */
export interface MeasuredItemSource<Item> {
  /** How many items the window lays out. */
  readonly itemCount: () => number;
  /** The item at `index`, below the count: the same object while it stands as it was measured. */
  readonly itemAt: (index: number) => Item;
  /** An item's room before it is measured, at the window's current width and type. */
  readonly estimateSize: (index: number) => number;
  /** The box the items are measured in off screen, or `undefined` before the window lays out. */
  readonly readBox: () => OffScreenBox | undefined;
  /** How far the window's element sits below its row's top, in CSS pixels. */
  readonly offsetInRowPx: () => number;
}

/**
 * One measured window's layout: the stable option members its virtualizer reads, the heights it
 * holds and measures, and the rows it draws.
 */
export class MeasuredItemWindow<Item> {
  readonly #viewport: TranscriptBodyViewport;
  readonly #rowKey: string;
  readonly #source: MeasuredItemSource<Item>;
  readonly #scroller: ScrollerWindowMembers;
  readonly #placeHold: ReaderPlaceHold;
  #virtualizer: MeasuredItemVirtualizer | undefined;
  /** The row's last known top, kept for a geometry sample taken while the viewport lets it go. */
  #rowStartPx = 0;
  /** The rows the window last committed to the page. */
  #committedRows: readonly MeasuredWindowRow[] = [];
  /** The item whose height the virtualizer holds at each index, measured at the current type. */
  #measuredItems: (Item | undefined)[] = [];
  #isTakingHeights = false;

  /** The off-screen measurement of the items the window has not measured drawn. */
  public readonly measurement: OffScreenMeasurement<Item>;

  /** The window's offset, viewport and refused writes, against the conversation scroller. */
  public readonly scrollToFn: ScrollerWindowMembers["scrollToFn"];
  public readonly observeElementOffset: ScrollerWindowMembers["observeElementOffset"];
  public readonly observeElementRect: ScrollerWindowMembers["observeElementRect"];
  public readonly initialOffset: ScrollerWindowMembers["initialOffset"];

  /**
   * An item's room when it resizes: the observer's border box, unrounded, so spacers add up to what
   * flow lays out. With no observation, as an item mounts, it answers what it last held.
   */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: MeasuredItemVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const measuredPx = entry?.borderBoxSize[0]?.blockSize;
    if (measuredPx !== undefined) {
      this.#markMeasured(index);
      return measuredPx;
    }
    return (
      instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
      this.#source.estimateSize(index)
    );
  };

  /**
   * The library's question whether to move the offset for an item that resized, always answered
   * no: its write would land on the window's element, which never scrolls. An item wholly above the
   * scroller's top, in a row the window holds the reader's place inside, moves the conversation by
   * its change instead, so what is being read stays where it is.
   */
  public readonly holdPlaceThroughResizedItem = (
    item: VirtualItem,
    deltaPx: number,
    instance: MeasuredItemVirtualizer,
  ): boolean => {
    if (this.#viewport.holdsPlaceInsideRow(this.#rowKey)) {
      this.#placeHold.holdThroughResizedItem(item.end, deltaPx, instance.scrollOffset ?? 0);
    }
    return false;
  };

  /**
   * `viewport` and `rowKey` are held for the window's life; `indexAttribute` is the attribute each
   * drawn or measured item carries its index on.
   */
  public constructor(
    viewport: TranscriptBodyViewport,
    rowKey: string,
    source: MeasuredItemSource<Item>,
    indexAttribute: string,
  ) {
    this.#viewport = viewport;
    this.#rowKey = rowKey;
    this.#source = source;
    const scroller = new ScrollerWindowMembers(viewport.scrollController, () => this.#topPx());
    this.#scroller = scroller;
    this.#placeHold = new ReaderPlaceHold(viewport.scrollController);
    this.scrollToFn = scroller.scrollToFn;
    this.observeElementOffset = scroller.observeElementOffset;
    this.observeElementRect = scroller.observeElementRect;
    this.initialOffset = scroller.initialOffset;
    this.measurement = new OffScreenMeasurement(
      {
        readBox: () => (this.#virtualizer === undefined ? undefined : source.readBox()),
        readUnmeasuredItems: (count) => this.#unmeasuredItems(count),
        takeHeights: (heights) => {
          this.#takeHeights(heights);
        },
      },
      indexAttribute,
    );
  }

  /**
   * Whether heights measured off screen are being handed to the virtualizer, whose changes are
   * then told once, after the last.
   */
  public get isTakingHeights(): boolean {
    return this.#isTakingHeights;
  }

  /** The items drawn for the library's `range`: on screen, and `bandScreenHeights` past them. */
  public drawnIndexesOf(range: Range, bandScreenHeights: DrawnBandScreenHeights): number[] {
    return this.#scroller.drawnIndexesOf(
      range,
      bandScreenHeights,
      (index) =>
        this.#virtualizer?.measurementsCache[index]?.size ?? this.#source.estimateSize(index),
    );
  }

  /** Takes the virtualizer this window's members were given to, which a new type re-measures. */
  public bindVirtualizer(virtualizer: MeasuredItemVirtualizer): void {
    this.#virtualizer = virtualizer;
  }

  /** The viewport the window opens against before its first geometry sample. */
  public initialRect(): ReturnType<ScrollerWindowMembers["initialRect"]> {
    return this.#scroller.initialRect();
  }

  /** Sends the window its offset again, after its element moved in its row. */
  public resendOffset(): void {
    this.#scroller.resendOffset();
  }

  /**
   * Lays the items out anew at a new width or type: every height measured at the old one is
   * dropped, the drawn items measured again at once, so the window never lays them out at an
   * estimate, and the rest measured off screen again; the item the reader reads in keeps its
   * place. The first type drops nothing it had.
   */
  public retype(hadType: boolean): void {
    this.#measuredItems = [];
    const virtualizer = this.#virtualizer;
    if (hadType && virtualizer !== undefined) {
      this.#placeHold.holdThroughRelayout(
        virtualizer,
        this.#viewport.holdsPlaceInsideRow(this.#rowKey),
        () => {
          virtualizer.measure();
          for (const element of virtualizer.elementsCache.values()) {
            if (element.isConnected) {
              const index = virtualizer.indexFromElement(element);
              this.#markMeasured(index);
              virtualizer.resizeItem(index, element.getBoundingClientRect().height);
            }
          }
        },
      );
    }
    this.measurement.stop();
    this.measurement.measure();
  }

  /**
   * The window's elements in document order: each drawn item, with a spacer for each run of
   * undrawn items before, between and after them, as tall as the window lays that run out.
   */
  public windowRows(
    virtualItems: readonly VirtualItem[],
    totalSizePx: number,
  ): MeasuredWindowRow[] {
    const rows: MeasuredWindowRow[] = [];
    let previousEndPx = 0;
    let previousIndex = -1;
    for (const item of virtualItems) {
      if (item.index > previousIndex + 1) {
        rows.push({
          kind: "spacer",
          key: `before:${String(item.index)}`,
          heightPx: item.start - previousEndPx,
          firstIndex: previousIndex + 1,
          lastIndex: item.index - 1,
        });
      }
      rows.push({ kind: "item", key: String(item.key), index: item.index });
      previousEndPx = item.end;
      previousIndex = item.index;
    }
    const lastIndex = this.#source.itemCount() - 1;
    if (previousIndex < lastIndex) {
      rows.push({
        kind: "spacer",
        key: "after",
        heightPx: totalSizePx - previousEndPx,
        firstIndex: previousIndex + 1,
        lastIndex,
      });
    }
    return rows;
  }

  /**
   * Takes the rows the window has just drawn, and writes the reader's place held through heights
   * taken off screen, which these rows' spacers now hold.
   */
  public commitRows(rows: readonly MeasuredWindowRow[]): void {
    this.#committedRows = rows;
    this.#placeHold.releaseWrite();
  }

  /**
   * Whether the rows for these items differ from the ones on the page: an item measured anew moves
   * the spacers around it without changing which items are drawn.
   */
  public differsFromCommittedRows(
    virtualItems: readonly VirtualItem[],
    totalSizePx: number,
  ): boolean {
    const rows = this.windowRows(virtualItems, totalSizePx);
    const committed = this.#committedRows;
    return (
      rows.length !== committed.length ||
      rows.some((row, index) => !isSameRow(row, committed[index]))
    );
  }

  /** The window's top in the scroller's content: its row's top, and its place in the row. */
  #topPx(): number {
    this.#rowStartPx = this.#viewport.rowStartPx(this.#rowKey) ?? this.#rowStartPx;
    return this.#rowStartPx + this.#source.offsetInRowPx();
  }

  /** Notes that the virtualizer holds the height of the item now at `index`. */
  #markMeasured(index: number): void {
    if (index < this.#source.itemCount()) {
      this.#measuredItems[index] = this.#source.itemAt(index);
    }
  }

  /**
   * The first `count` items whose height the virtualizer does not hold, in order. A drawn item's
   * is held, as its resize observation reports each change, so a growing item drawn on screen is
   * never measured again off screen.
   */
  #unmeasuredItems(count: number): OffScreenItem<Item>[] {
    const items: OffScreenItem<Item>[] = [];
    const itemCount = this.#source.itemCount();
    for (let index = 0; index < itemCount && items.length < count; index += 1) {
      const item = this.#source.itemAt(index);
      if (this.#measuredItems[index] === item) {
        continue;
      }
      if (this.#isDrawn(index)) {
        this.#measuredItems[index] = item;
      } else {
        items.push({ index, item });
      }
    }
    return items;
  }

  /** Whether item `index` is drawn in the window now, observed as it resizes. */
  #isDrawn(index: number): boolean {
    const virtualizer = this.#virtualizer;
    return (
      virtualizer?.elementsCache.get(virtualizer.options.getItemKey(index))?.isConnected === true
    );
  }

  /**
   * Hands the virtualizer the heights measured off screen of the items still standing as they were
   * drawn, then tells its change once: an item that changed since is measured again. The reader's
   * place held through them is written once the spacers that hold them are drawn, so the scroller
   * never moves past a page that has not grown yet.
   */
  #takeHeights(heights: readonly OffScreenItemHeight<Item>[]): void {
    const virtualizer = this.#virtualizer;
    if (virtualizer === undefined) {
      return;
    }
    this.#isTakingHeights = true;
    this.#placeHold.deferWrite();
    try {
      for (const { index, item, heightPx } of heights) {
        if (index < this.#source.itemCount() && this.#source.itemAt(index) === item) {
          this.#measuredItems[index] = item;
          virtualizer.resizeItem(index, heightPx);
          // Lays the items out again, so the next one's place, which the reader's hold judges,
          // carries this one's change, as an item drawn and resized does.
          virtualizer.getTotalSize();
        }
      }
    } finally {
      this.#isTakingHeights = false;
    }
    if (this.differsFromCommittedRows(virtualizer.getVirtualItems(), virtualizer.getTotalSize())) {
      virtualizer.options.onChange?.(virtualizer, false);
    } else {
      this.#placeHold.releaseWrite();
    }
  }
}

function isSameRow(row: MeasuredWindowRow, held: MeasuredWindowRow | undefined): boolean {
  if (row.kind === "spacer") {
    return (
      held?.kind === "spacer" &&
      held.key === row.key &&
      held.heightPx === row.heightPx &&
      held.firstIndex === row.firstIndex &&
      held.lastIndex === row.lastIndex
    );
  }
  return held?.kind === "item" && held.key === row.key;
}
