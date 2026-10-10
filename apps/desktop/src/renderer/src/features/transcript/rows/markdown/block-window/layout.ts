// The members a windowed body's virtualizer is built with, and the state behind them. The window
// lays the body's blocks out against the conversation scroller through `ScrollerWindowMembers`,
// from the body's top in the scroller's content. Drawn blocks sit in flow, so their margins
// collapse and a growing block moves what follows it in the same layout; a spacer stands for each
// undrawn run. A long table in a block windows its own rows against the same scroller, from the
// block's place this layout answers as its table placement, and hears each change that may move it.

import type { Range, VirtualItem, Virtualizer } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { blockSourceStartOf, type SettledMarkdownBlock } from "../body-blocks.js";
import { isSameBodyType, readMarkdownBodyType, type MarkdownBodyType } from "../body-type.js";
import { offsetInRowPx, ScrollerWindowMembers } from "../scroller-window.js";
import { type TableBodyPlacement, type TablePlacementChange } from "../table-window/context.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "./markers.js";
import { type MarkdownWindowViewport } from "./context.js";
import {
  DEFAULT_BLOCK_TYPOGRAPHY,
  estimateBlockHeightPx,
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

/** The virtualizer a windowed body runs, over the body's element and its block wrappers. */
export type BlockVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/** The body's blocks as the window counts them: its settled blocks, then its tail if it has one. */
export interface WindowedBlocks {
  readonly settledBlocks: readonly SettledMarkdownBlock[];
  readonly volatileTail: string;
  /** The definitions every block is parsed after, whose length every parsed offset counts. */
  readonly definitionPreamble: string;
  /** Cuts a settled block's text from its body's, for an estimate that lets it go. */
  readonly readBlockSource: (block: SettledMarkdownBlock) => string;
}

/** What one body's window is laid out against. */
export interface BlockWindowLayoutOptions {
  /** The viewport the body is drawn in; held for the layout's life. */
  readonly viewport: MarkdownWindowViewport;
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
  readonly #viewport: MarkdownWindowViewport;
  readonly #rowKey: string;
  readonly #scroller: ScrollerWindowMembers;
  readonly #placementChanges = new Emitter<TablePlacementChange>("block placement change");
  #blocks: WindowedBlocks;
  #bodyTextLength: number;
  #bodyElement: HTMLElement | undefined;
  #stopObservingBody: Unsubscribe | undefined;
  #virtualizer: BlockVirtualizer | undefined;
  /** The body's width and text size, read from its resize observations. */
  #bodyType: MarkdownBodyType | undefined;
  /** How far the body's top sits below its row's, measured when the body's type changes. */
  #bodyOffsetInRowPx = 0;
  /** The row's last known top, kept for a geometry sample taken while the viewport lets it go. */
  #rowStartPx = 0;
  /** This mount's measured blocks, by key. */
  readonly #geometries = new Map<string, BlockGeometry>();
  /** This mount's estimates for blocks it has not measured, by key, at the current width. */
  readonly #estimates = new Map<string, number>();
  /** The rows the body last committed to the page. */
  #committedRows: readonly BlockWindowRow[] = [];

  /** The body's element: what the window observes its blocks from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#bodyElement ?? null;

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
    const held = this.#estimates.get(key);
    if (held !== undefined) {
      return held;
    }
    const block = this.#blocks.settledBlocks[index];
    if (block === undefined) {
      // The tail changes every frame, so its estimate is never held.
      return estimateBlockHeightPx(this.#blocks.volatileTail, this.#typography());
    }
    const recalled = this.#recall(index);
    const estimate =
      recalled === undefined
        ? estimateBlockHeightPx(this.#blocks.readBlockSource(block), this.#typography())
        : this.#sizeOf(index, recalled);
    this.#estimates.set(key, estimate);
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

  /** The body's element, and its size observation: its width, type and place in its row. */
  public readonly attachBody = (element: HTMLElement | null): void => {
    this.#stopObservingBody?.();
    this.#stopObservingBody = undefined;
    this.#bodyElement = element ?? undefined;
    if (element !== null) {
      this.#stopObservingBody = observeElementResize(element, (entries) => {
        this.#readBody(element, entries.at(-1));
      });
    }
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
    this.scrollToFn = scroller.scrollToFn;
    this.observeElementOffset = scroller.observeElementOffset;
    this.observeElementRect = scroller.observeElementRect;
    this.initialOffset = scroller.initialOffset;
  }

  /** How many blocks the window lays out: the settled ones and the tail. */
  public get blockCount(): number {
    return this.#blocks.settledBlocks.length + (this.#blocks.volatileTail === "" ? 0 : 1);
  }

  /** The key a block is measured and drawn under. */
  public keyOf(index: number): string {
    return windowedBlockKeyOf(this.#blocks.settledBlocks, index);
  }

  /** The body's width and text size, or `undefined` before it is laid out. */
  public get bodyType(): MarkdownBodyType | undefined {
    return this.#bodyType;
  }

  public get ownerDocument(): Document | undefined {
    return this.#bodyElement?.ownerDocument;
  }

  /** How long the definitions are that every parsed offset in this body counts. */
  public get definitionPreambleLength(): number {
    return this.#blocks.definitionPreamble.length;
  }

  /** Takes the body's blocks and its text's length for this frame. */
  public setBlocks(blocks: WindowedBlocks, bodyTextLength: number): void {
    this.#blocks = blocks;
    this.#bodyTextLength = bodyTextLength;
  }

  public blockSourceStart(index: number): number {
    return blockSourceStartOf(this.#blocks, this.#bodyTextLength, index);
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
   * changed, `"laid-out"` when the body was laid out at a new width.
   */
  public subscribeToPlacement(listener: (change: TablePlacementChange) => void): Unsubscribe {
    return this.#placementChanges.subscribe(listener);
  }

  /** Tells the tables inside the body's blocks that a block may have moved. */
  public announcePlacementChange(change: TablePlacementChange): void {
    this.#placementChanges.emit(change);
  }

  /** The blocks drawn for the library's `range`: those on screen and the drawn band past them. */
  public drawnIndexesOf(range: Range): number[] {
    return this.#scroller.drawnIndexesOf(
      range,
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
        key: String(item.key),
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
    const geometry = this.#geometries.get(String(item.key));
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
    this.#estimates.clear();
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
   * the drawn blocks again at once, so the window never lays them out at an estimate.
   */
  #remeasureAtNewType(): void {
    const virtualizer = this.#virtualizer;
    if (virtualizer === undefined) {
      return;
    }
    this.#geometries.clear();
    virtualizer.measure();
    for (const element of virtualizer.elementsCache.values()) {
      if (element.isConnected) {
        const index = virtualizer.indexFromElement(element);
        const geometry = readBlockGeometry(element, element.getBoundingClientRect().height);
        this.#record(index, geometry, virtualizer);
        virtualizer.resizeItem(index, this.#sizeOf(index, geometry));
      }
    }
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
    const block = this.#blocks.settledBlocks[index];
    const bodyType = this.#bodyType;
    return block === undefined || bodyType === undefined
      ? undefined
      : { fingerprint: block.fingerprint, bodyType, isFinal: index === this.blockCount - 1 };
  }
}

/** The key a windowed block is measured and drawn under: a settled block's own, or the tail's. */
export function windowedBlockKeyOf(
  settledBlocks: readonly SettledMarkdownBlock[],
  index: number,
): string {
  return settledBlocks[index]?.key ?? VOLATILE_TAIL_KEY;
}

/** The tail's key: one element that grows, frame after frame, until its blocks settle. */
const VOLATILE_TAIL_KEY = "volatile-tail";

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
