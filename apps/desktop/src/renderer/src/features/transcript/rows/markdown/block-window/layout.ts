// The members a windowed body's virtualizer is built with, and the state behind them. The window
// lays the body's blocks out against the conversation scroller through `ScrollerWindowMembers`,
// from the body's top in the scroller's content. Drawn blocks sit in flow, so their margins
// collapse and a growing block moves what follows it in the same layout; a spacer stands for each
// undrawn run. A long table in a block windows its own rows against the same scroller, from the
// block's place this layout answers as its table placement, and hears each change that may move it.

import type { Range, VirtualItem, Virtualizer } from "@tanstack/virtual-core";
import type { RootContent } from "mdast";

import type { Unsubscribe } from "#shared/preload-api.js";
import { BlockFlag, type BlockRecords } from "../block-records.js";
import { blockSourceStartOf } from "../body-blocks/snapshot.js";
import { isSameBodyType, readMarkdownBodyType, type MarkdownBodyType } from "../body-type.js";
import { type DrawnBandScreenHeights } from "#renderer/lib/scroll/window-side.js";
import { ReaderPlaceHold } from "#renderer/lib/scroll/reader-place-hold.js";
import {
  offsetInRowPx,
  ScrollerWindowMembers,
} from "#renderer/components/TranscriptBodyViewport/scroller-window.js";
import { type TableBodyPlacement, type TablePlacementChange } from "../table-window/context.js";
import { TablePlacementReports } from "../table-window/placement-reports.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "./markers.js";
import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import {
  DEFAULT_BLOCK_TYPOGRAPHY,
  estimateBlockHeightPx,
  FENCE_OPENER,
  lineLengthsOf,
  type BlockTypography,
} from "./estimate.js";
import {
  blockSizePx,
  collapsedMarginPx,
  readBlockGeometry,
  type BlockGeometry,
} from "./geometry.js";
import {
  recallBlockGeometry,
  rememberBlockGeometry,
  type BlockGeometryAddress,
} from "./geometry-memory.js";
import { warmIdeographFallback } from "../table-window/ideograph-fallback-warm.js";

/** The virtualizer a windowed body runs, over the body's element and its block wrappers. */
export type BlockVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/**
 * The body's blocks as the window counts them: the first `settledCount` of its records, then its
 * tail once it has nodes to draw.
 */
export interface WindowedBlocks {
  readonly records: BlockRecords;
  /** How many of `records`' blocks are drawn on their own. */
  readonly settledCount: number;
  readonly volatileTail: string;
  /** The tail's nodes, or `undefined` before its first tree lands. */
  readonly tailNodes: readonly RootContent[] | undefined;
  /** The definitions every offset in a drawn block's tree counts before the block's own text. */
  readonly readDefinitionPreamble: (index: number) => string;
}

/** What one body's window is laid out against. */
export interface BlockWindowLayoutOptions {
  /** The viewport the body is drawn in; held for the layout's life. */
  readonly viewport: TranscriptBodyViewport;
  /** The row the body belongs to, whose top the body's is measured from. */
  readonly rowKey: string;
  readonly blocks: WindowedBlocks;
  /** The body's text length, in UTF-16 code units, which the tail ends at. */
  readonly bodyTextLength: number;
}

/** One element of a windowed body, in document order. */
export type BlockWindowRow =
  | {
      readonly kind: "block";
      readonly key: string;
      readonly index: number;
      /** Whether this is the body's last block, whose end is the body's end. */
      readonly isFinal: boolean;
    }
  | {
      /** The room of a run of undrawn blocks, where flow would lay them out. */
      readonly kind: "spacer";
      readonly key: string;
      readonly heightPx: number;
    };

/**
 * One windowed body's layout: the stable option members its virtualizer reads, the blocks'
 * measured geometry, and the body's place in the scroller.
 */
export class BlockWindowLayout implements TableBodyPlacement {
  readonly #viewport: TranscriptBodyViewport;
  readonly #rowKey: string;
  readonly #scroller: ScrollerWindowMembers;
  readonly #placeHold: ReaderPlaceHold;
  readonly #reports = new TablePlacementReports("block placement change", (element, entry) => {
    this.#readBody(element, entry);
  });
  #blocks: WindowedBlocks;
  #bodyTextLength: number;
  #virtualizer: BlockVirtualizer | undefined;
  /** The body's width and text size, read from its resize observations. */
  #bodyType: MarkdownBodyType | undefined;
  /** How far the body's top sits below its row's, measured when the body's type changes. */
  #bodyOffsetInRowPx = 0;
  /** The row's last known top, kept for a geometry sample taken while the viewport lets it go. */
  #rowStartPx = 0;
  /** This mount's measured blocks, by key. */
  readonly #geometries = new Map<number, BlockGeometry>();
  /**
   * This mount's estimates for the settled blocks it has not measured, by index, at the current
   * type, `NaN` where none is held: refilled from the records' line lengths, never from text.
   */
  #estimates = new Float32Array(0);
  /** The records `#estimates` were made from. */
  #estimatedRecords: BlockRecords | undefined;
  /** The rows the body last committed to the page. */
  #committedRows: readonly BlockWindowRow[] = [];

  /** The body's element: what the window observes its blocks from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#reports.element ?? null;

  /** The window's offset, viewport and refused writes, against the conversation scroller. */
  public readonly scrollToFn: ScrollerWindowMembers["scrollToFn"];
  public readonly observeElementOffset: ScrollerWindowMembers["observeElementOffset"];
  public readonly observeElementRect: ScrollerWindowMembers["observeElementRect"];
  public readonly initialOffset: ScrollerWindowMembers["initialOffset"];

  /** One block's estimated room in the window, from what it last measured or from its text. */
  public readonly estimateSize = (index: number): number => {
    const key = this.keyOf(index);
    const measured = this.#geometries.get(key);
    if (measured !== undefined) {
      return this.#sizeOf(index, measured);
    }
    const { records, settledCount, volatileTail } = this.#blocks;
    if (index >= settledCount) {
      // The tail changes every frame, so its estimate is never held.
      return estimateBlockHeightPx(
        lineLengthsOf(volatileTail),
        FENCE_OPENER.test(volatileTail),
        this.#typography(),
      );
    }
    const held = this.#estimates[index];
    if (held !== undefined && !Number.isNaN(held)) {
      return held;
    }
    const recalled = this.#recall(index);
    const estimate =
      recalled === undefined
        ? estimateBlockHeightPx(
            records.lineLengthsOf(index),
            records.hasFlag(index, BlockFlag.Fence),
            this.#typography(),
          )
        : this.#sizeOf(index, recalled);
    this.#holdEstimate(index, estimate);
    return estimate;
  };

  /**
   * A block's room in the window when its wrapper resizes. The height is the observer's border box;
   * the edge margins are read from computed styles, which forces no layout. With no observation,
   * as a wrapper mounts, it answers what it last held and reads nothing.
   */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: BlockVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const borderBox = entry?.borderBoxSize[0];
    if (borderBox === undefined) {
      return instance.itemSizeCache.get(this.keyOf(index)) ?? this.estimateSize(index);
    }
    const geometry = readBlockGeometry(element, borderBox.blockSize);
    this.#record(index, geometry, instance);
    return this.#sizeOf(index, geometry);
  };

  /**
   * The library's question whether to move the offset for a block that resized, always answered
   * no: its write would land on the body, which never scrolls. A block wholly above the scroller's
   * top, in a row the body holds the reader's place inside, moves the conversation by its change
   * instead, so the text being read stays where it is.
   */
  public readonly holdPlaceThroughResizedBlock = (
    item: VirtualItem,
    deltaPx: number,
    instance: BlockVirtualizer,
  ): boolean => {
    if (this.#viewport.holdsPlaceInsideRow(this.#rowKey)) {
      this.#placeHold.holdThroughResizedItem(item.end, deltaPx, instance.scrollOffset ?? 0);
    }
    return false;
  };

  /** The body's element, and its size observation: its width, type and place in its row. */
  public readonly attachBody = (element: HTMLElement | null): void => {
    if (element !== null) {
      warmIdeographFallback(element);
    }
    this.#reports.attach(element);
  };

  public constructor(options: BlockWindowLayoutOptions) {
    this.#viewport = options.viewport;
    this.#rowKey = options.rowKey;
    this.#blocks = options.blocks;
    this.#bodyTextLength = options.bodyTextLength;
    const scroller = new ScrollerWindowMembers(options.viewport.scrollController, () =>
      this.#bodyTopPx(),
    );
    this.#scroller = scroller;
    this.#placeHold = new ReaderPlaceHold(options.viewport.scrollController);
    this.scrollToFn = scroller.scrollToFn;
    this.observeElementOffset = scroller.observeElementOffset;
    this.observeElementRect = scroller.observeElementRect;
    this.initialOffset = scroller.initialOffset;
  }

  /** How many blocks the window lays out: the drawn settled ones, and the tail once it draws. */
  public get blockCount(): number {
    const tailNodes = this.#blocks.tailNodes;
    return this.#blocks.settledCount + (tailNodes === undefined || tailNodes.length === 0 ? 0 : 1);
  }

  /** The key a block is measured and drawn under. */
  public keyOf(index: number): number {
    return windowedBlockKeyOf(this.#blocks, index);
  }

  /** The body's width and text size, or `undefined` before it is laid out. */
  public get bodyType(): MarkdownBodyType | undefined {
    return this.#bodyType;
  }

  public get layoutCount(): number {
    return this.#reports.layoutCount;
  }

  public get ownerDocument(): Document | undefined {
    return this.#reports.element?.ownerDocument;
  }

  /** The key of the transcript row the body is drawn in. */
  public get rowKey(): string {
    return this.#rowKey;
  }

  /** The definitions every offset in block `index`'s drawn tree counts before its own text. */
  public definitionPreamble(index: number): string {
    return this.#blocks.readDefinitionPreamble(index);
  }

  /** Takes the body's blocks and its text's length for this frame. */
  public setBlocks(blocks: WindowedBlocks, bodyTextLength: number): void {
    const previous = this.#blocks;
    this.#blocks = blocks;
    this.#bodyTextLength = bodyTextLength;
    if (blocks.records !== this.#estimatedRecords) {
      this.#estimatedRecords = blocks.records;
      this.#estimates.fill(Number.NaN);
    }
    if (blocks.records === previous.records && blocks.settledCount < previous.settledCount) {
      // Blocks given back to the tail may settle again with other text under the same keys.
      for (let index = blocks.settledCount; index < previous.settledCount; index += 1) {
        this.#geometries.delete(blocks.records.itemKeyAt(index));
        this.#estimates[index] = Number.NaN;
      }
    }
  }

  public blockSourceStart(index: number): number {
    return blockSourceStartOf(this.#blocks, this.#bodyTextLength, index);
  }

  /** A settled block's fingerprint; `undefined` for the streaming tail. */
  public blockFingerprint(index: number): string | undefined {
    return index < this.#blocks.settledCount
      ? this.#blocks.records.fingerprintAt(index)
      : undefined;
  }

  /** A table's anchor here is the wrapper of the block it is drawn in. */
  public anchorOf(element: Element): Element | null {
    return element.closest(`[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}]`);
  }

  /**
   * A block wrapper's top edge in the scroller's content, from the window's own layout of the
   * body, so it reads no element; `undefined` for an index the window does not hold.
   */
  public anchorTopPx(blockIndex: number): number | undefined {
    const item = this.#virtualizer?.measurementsCache[blockIndex];
    return item === undefined ? undefined : this.#bodyTopPx() + this.#edgesOf(item).borderTopPx;
  }

  /**
   * Hears each change that may move a block: `"moved"` when a block measured or the drawn blocks
   * changed, `"laid-out"` when the body was laid out at a new width, or when a table that read the
   * body at `seenLayoutCount` starts to listen having missed such a layout.
   */
  public subscribeToPlacement(
    listener: (change: TablePlacementChange) => void,
    seenLayoutCount: number,
  ): Unsubscribe {
    return this.#reports.subscribe(listener, seenLayoutCount);
  }

  /** Tells the tables inside the body's blocks that a block may have moved. */
  public announcePlacementChange(change: TablePlacementChange): void {
    this.#reports.announce(change);
  }

  /** The blocks drawn for the library's `range`: on screen, and `bandScreenHeights` past them. */
  public drawnIndexesOf(range: Range, bandScreenHeights: DrawnBandScreenHeights): number[] {
    return this.#scroller.drawnIndexesOf(
      range,
      bandScreenHeights,
      (index) => this.#virtualizer?.measurementsCache[index]?.size ?? this.estimateSize(index),
    );
  }

  /** Takes the virtualizer this layout's members were given to, which a new width re-measures. */
  public bindVirtualizer(virtualizer: BlockVirtualizer): void {
    this.#virtualizer = virtualizer;
  }

  /** The viewport the window opens against before its first geometry sample. */
  public initialRect(): ReturnType<ScrollerWindowMembers["initialRect"]> {
    return this.#scroller.initialRect();
  }

  /**
   * The body's elements in document order: each drawn block, with a spacer for each run of
   * undrawn blocks before, between and after them, as tall as flow would lay that run out.
   */
  public windowRows(virtualItems: readonly VirtualItem[], totalSizePx: number): BlockWindowRow[] {
    const rows: BlockWindowRow[] = [];
    const lastIndex = this.blockCount - 1;
    // Where the previous drawn block's bottom margin ends: the top of the room after it.
    let previousEndPx = 0;
    let previousIndex = -1;
    for (const item of virtualItems) {
      const edges = this.#edgesOf(item);
      if (item.index > previousIndex + 1) {
        pushSpacer(
          rows,
          `before:${String(item.key)}`,
          edges.borderTopPx - edges.topMarginPx - previousEndPx,
        );
      }
      rows.push({
        kind: "block",
        key: this.#reactKeyOf(item.index),
        index: item.index,
        isFinal: item.index === lastIndex,
      });
      previousEndPx = edges.borderBottomPx + edges.bottomMarginPx;
      previousIndex = item.index;
    }
    if (previousIndex < lastIndex) {
      pushSpacer(rows, "after", totalSizePx - previousEndPx);
    }
    return rows;
  }

  /** Takes the rows the body has just drawn. */
  public commitRows(rows: readonly BlockWindowRow[]): void {
    this.#committedRows = rows;
  }

  /**
   * Whether the rows for these items differ from the ones on the page: a block measured anew moves
   * the spacers around it without changing which blocks are drawn.
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

  /** The body's top in the scroller's content: its row's top, and its place in the row. */
  #bodyTopPx(): number {
    this.#rowStartPx = this.#viewport.rowStartPx(this.#rowKey) ?? this.#rowStartPx;
    return this.#rowStartPx + this.#bodyOffsetInRowPx;
  }

  /**
   * Where one drawn block's border box and edge margins sit in the window, from its room there:
   * a block not yet measured is taken as all border box, its margins unknown.
   */
  #edgesOf(item: VirtualItem): BlockEdges {
    const geometry = this.#geometries.get(this.keyOf(item.index));
    if (geometry === undefined) {
      return {
        borderTopPx: item.start,
        borderBottomPx: item.end,
        topMarginPx: 0,
        bottomMarginPx: 0,
      };
    }
    const nextTopMarginPx = this.#nextTopMarginPx(item.index);
    const gapAfterPx =
      nextTopMarginPx === undefined
        ? geometry.bottomMarginPx
        : collapsedMarginPx(geometry.bottomMarginPx, nextTopMarginPx);
    return {
      borderTopPx: item.start + (item.index === 0 ? geometry.topMarginPx : 0),
      borderBottomPx: item.end - gapAfterPx,
      topMarginPx: geometry.topMarginPx,
      bottomMarginPx: geometry.bottomMarginPx,
    };
  }

  /**
   * Reads the body when its width or text size changes, the first observation included: its type
   * for the estimates, and its place in its row. A height change alone moves neither, and is read
   * for nothing.
   */
  #readBody(element: HTMLElement, entry: ResizeObserverEntry | undefined): void {
    const bodyType = readMarkdownBodyType(element, entry?.contentBoxSize[0]?.inlineSize ?? 0);
    const previousType = this.#bodyType;
    if (isSameBodyType(bodyType, previousType)) {
      return;
    }
    this.#bodyType = bodyType;
    this.#bodyOffsetInRowPx = offsetInRowPx(element);
    this.#estimates.fill(Number.NaN);
    if (previousType !== undefined) {
      this.#remeasureAtNewType();
    }
    this.#scroller.resendOffset();
    this.announcePlacementChange("laid-out");
  }

  /** The type the estimates read: the body's, or a reply's default before it is laid out. */
  #typography(): BlockTypography {
    return this.#bodyType ?? DEFAULT_BLOCK_TYPOGRAPHY;
  }

  /**
   * Drops every height measured at the old width or text size, since text wraps anew, and measures
   * the drawn blocks again at once, so the window never lays them out at an estimate; the block the
   * reader reads in keeps its place.
   */
  #remeasureAtNewType(): void {
    const virtualizer = this.#virtualizer;
    if (virtualizer === undefined) {
      return;
    }
    this.#geometries.clear();
    this.#placeHold.holdThroughRelayout(
      virtualizer,
      this.#viewport.holdsPlaceInsideRow(this.#rowKey),
      () => {
        virtualizer.measure();
        for (const element of virtualizer.elementsCache.values()) {
          if (element.isConnected) {
            const index = virtualizer.indexFromElement(element);
            const geometry = readBlockGeometry(element, element.getBoundingClientRect().height);
            this.#record(index, geometry, virtualizer);
            virtualizer.resizeItem(index, this.#sizeOf(index, geometry));
          }
        }
      },
    );
  }

  /**
   * Keeps a block's measured geometry, files a settled one in the memory, and gives the block
   * before it its room again, which ends where this block's top margin meets its bottom one.
   */
  #record(index: number, geometry: BlockGeometry, virtualizer: BlockVirtualizer): void {
    this.#geometries.set(this.keyOf(index), geometry);
    const address = this.#addressOf(index);
    if (address !== undefined) {
      rememberBlockGeometry(address, geometry);
    }
    const previous = index > 0 ? this.#geometryOf(index - 1) : undefined;
    if (previous !== undefined) {
      virtualizer.resizeItem(index - 1, this.#sizeOf(index - 1, previous));
    }
  }

  /** A block's room in the window, from its geometry and its neighbors'. */
  #sizeOf(index: number, geometry: BlockGeometry): number {
    return blockSizePx(geometry, {
      isFirst: index === 0,
      nextTopMarginPx: this.#nextTopMarginPx(index),
    });
  }

  /** The next block's top margin, `0` while it is unmeasured, `undefined` after the last block. */
  #nextTopMarginPx(index: number): number | undefined {
    return index + 1 < this.blockCount
      ? (this.#geometryOf(index + 1)?.topMarginPx ?? 0)
      : undefined;
  }

  #geometryOf(index: number): BlockGeometry | undefined {
    return this.#geometries.get(this.keyOf(index)) ?? this.#recall(index);
  }

  #recall(index: number): BlockGeometry | undefined {
    const address = this.#addressOf(index);
    return address === undefined ? undefined : recallBlockGeometry(address);
  }

  /** Where a settled block's geometry is filed; the tail and an unmeasured body have none. */
  #addressOf(index: number): BlockGeometryAddress | undefined {
    const bodyType = this.#bodyType;
    const { records, settledCount } = this.#blocks;
    return index >= settledCount || bodyType === undefined
      ? undefined
      : {
          textLength: records.endOf(index) - records.startOf(index),
          textHash: records.hashAt(index),
          bodyType,
          isFinal: index === this.blockCount - 1,
        };
  }

  /**
   * The React key block `index` is drawn under: a settled block's place and text, or the tail's.
   */
  #reactKeyOf(index: number): string {
    return index < this.#blocks.settledCount
      ? this.#blocks.records.reactKeyAt(index)
      : VOLATILE_TAIL_REACT_KEY;
  }

  /** Holds a settled block's estimate, growing the estimates as the records do. */
  #holdEstimate(index: number, estimate: number): void {
    if (index >= this.#estimates.length) {
      const grown = new Float32Array(Math.max(INITIAL_ESTIMATE_CAPACITY, (index + 1) * 2));
      grown.fill(Number.NaN);
      grown.set(this.#estimates);
      this.#estimates = grown;
    }
    this.#estimates[index] = estimate;
  }
}

/**
 * The number a windowed block is measured under: a settled block's own (`BlockRecords.itemKeyAt`),
 * or the tail's, `-1`.
 */
export function windowedBlockKeyOf(
  blocks: Pick<WindowedBlocks, "records" | "settledCount">,
  index: number,
): number {
  return index < blocks.settledCount ? blocks.records.itemKeyAt(index) : VOLATILE_TAIL_KEY;
}

/** The tail's keys: one element that grows, frame after frame, until its blocks settle. */
const VOLATILE_TAIL_KEY = -1;
const VOLATILE_TAIL_REACT_KEY = "volatile-tail";

/** How many settled blocks' estimates the window holds room for before it first grows. */
const INITIAL_ESTIMATE_CAPACITY = 64;

/** Where a drawn block's border box and margins sit in the window, in CSS pixels. */
interface BlockEdges {
  readonly borderTopPx: number;
  readonly borderBottomPx: number;
  readonly topMarginPx: number;
  readonly bottomMarginPx: number;
}

function isSameRow(row: BlockWindowRow, held: BlockWindowRow | undefined): boolean {
  if (row.kind === "spacer") {
    return held?.kind === "spacer" && held.key === row.key && held.heightPx === row.heightPx;
  }
  return held?.kind === "block" && held.key === row.key && held.isFinal === row.isFinal;
}

/**
 * A spacer of `heightPx`, if it has any height. A spacer with none is left out: an empty box
 * would let the margins on either side of it collapse through it.
 */
function pushSpacer(rows: BlockWindowRow[], key: string, heightPx: number): void {
  if (heightPx > 0) {
    rows.push({ kind: "spacer", key, heightPx });
  }
}
