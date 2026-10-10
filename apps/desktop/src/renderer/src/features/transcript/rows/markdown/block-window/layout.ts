// The members a windowed body's virtualizer is built with, and the state behind them. The window
// lays the body's blocks out against the conversation scroller: its offset is the scroller's less
// the body's top in the scroller's content, taken from the scroll controller's published geometry,
// so following a scroll reads no element. Drawn blocks sit in flow, so their margins collapse and
// a growing block moves what follows it in the same layout; a spacer stands for each undrawn run.
// The window never writes the scroller and never compensates a block that changed size: the
// conversation's own window keeps the reader's place.

import type { Rect, VirtualItem, Virtualizer } from "@tanstack/react-virtual";

import type { Unsubscribe } from "#shared/preload-api.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { type SettledMarkdownBlock } from "../body-blocks.js";
import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
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
  /** Cuts a settled block's text from its body's, for an estimate that lets it go. */
  readonly readBlockSource: (block: SettledMarkdownBlock) => string;
}

/** What one body's window is laid out against. */
export interface BlockWindowLayoutOptions {
  /** The viewport the body is drawn in; held for the layout's life. */
  readonly viewport: TranscriptBodyViewport;
  /** The row the body belongs to, whose top the body's is measured from. */
  readonly rowKey: string;
  readonly blocks: WindowedBlocks;
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
export class BlockWindowLayout {
  readonly #viewport: TranscriptBodyViewport;
  readonly #rowKey: string;
  #blocks: WindowedBlocks;
  #bodyElement: HTMLElement | undefined;
  #stopObservingBody: Unsubscribe | undefined;
  #virtualizer: BlockVirtualizer | undefined;
  #typography: BlockTypography = DEFAULT_BLOCK_TYPOGRAPHY;
  /** How far the body's top sits below its row's, measured when the body's width changes. */
  #bodyOffsetInRowPx = 0;
  /** The row's last known top, kept for a geometry sample taken while the viewport lets it go. */
  #rowStartPx = 0;
  /** This mount's measured blocks, by key. */
  readonly #geometries = new Map<string, BlockGeometry>();
  /** This mount's estimates for blocks it has not measured, by key, at the current width. */
  readonly #estimates = new Map<string, number>();
  /** Sends the window the offset again, for a body whose top moved under an unmoved scroller. */
  #resendOffset: (() => void) | undefined;
  /** The rows the body last committed to the page. */
  #committedRows: readonly BlockWindowRow[] = [];

  /** The body's element: what the window observes its blocks from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#bodyElement ?? null;

  /** The window's writes, made by no one: the body never moves the conversation's offset. */
  public readonly scrollToFn = (): void => {
    // The conversation's own window holds the reader's place; a body writing it would fight that.
  };

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
      return estimateBlockHeightPx(this.#blocks.volatileTail, this.#typography);
    }
    const recalled = this.#recall(index);
    const estimate =
      recalled === undefined
        ? estimateBlockHeightPx(this.#blocks.readBlockSource(block), this.#typography)
        : this.#sizeOf(index, recalled);
    this.#estimates.set(key, estimate);
    return estimate;
  };

  /** The window's offset: the scroller's, less the body's top in the scroller's content. */
  public readonly observeElementOffset = (
    _instance: BlockVirtualizer,
    sink: (offset: number, isScrolling: boolean) => void,
  ): Unsubscribe => {
    const scrollController = this.#viewport.scrollController;
    const sendOffset = (): void => {
      const geometry = scrollController.geometry;
      if (geometry !== undefined) {
        // Never `isScrolling`: it arms the library's scroll-end timers, which the body never needs.
        sink(geometry.scrollTop - this.#bodyTopPx(), false);
      }
    };
    const unsubscribe = scrollController.subscribeToGeometry(sendOffset);
    this.#resendOffset = sendOffset;
    return () => {
      unsubscribe();
      this.#resendOffset = undefined;
    };
  };

  /** The window's viewport: the scroller's own height, from the same geometry. */
  public readonly observeElementRect = (
    _instance: BlockVirtualizer,
    sink: (rect: Rect) => void,
  ): Unsubscribe =>
    this.#viewport.scrollController.subscribeToGeometry((geometry) => {
      // A vertical list: the library reads `height` and never `width`, which is not sampled.
      sink({ width: 0, height: geometry.viewportHeight });
    });

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

  /** Where the window opens before its first geometry sample: the scroller's offset now. */
  public readonly initialOffset = (): number => {
    const geometry = this.#viewport.scrollController.geometry;
    return geometry === undefined ? 0 : geometry.scrollTop - this.#bodyTopPx();
  };

  public constructor(options: BlockWindowLayoutOptions) {
    this.#viewport = options.viewport;
    this.#rowKey = options.rowKey;
    this.#blocks = options.blocks;
  }

  /** How many blocks the window lays out: the settled ones and the tail. */
  public get blockCount(): number {
    return this.#blocks.settledBlocks.length + (this.#blocks.volatileTail === "" ? 0 : 1);
  }

  /** The key a block is measured and drawn under. */
  public keyOf(index: number): string {
    return windowedBlockKeyOf(this.#blocks.settledBlocks, index);
  }

  /** Takes the body's blocks for this frame. */
  public setBlocks(blocks: WindowedBlocks): void {
    this.#blocks = blocks;
  }

  /** Takes the virtualizer this layout's members were given to, which a new width re-measures. */
  public bindVirtualizer(virtualizer: BlockVirtualizer): void {
    this.#virtualizer = virtualizer;
  }

  /** The viewport the window opens against before its first geometry sample. */
  public initialRect(): Rect {
    return { width: 0, height: this.#viewport.scrollController.geometry?.viewportHeight ?? 0 };
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
   * Reads the body when its width changes, the first observation included: its type for the
   * estimates, and its place in its row. A height change moves neither, and is read for nothing.
   */
  #readBody(element: HTMLElement, entry: ResizeObserverEntry | undefined): void {
    const widthPx = Math.round(entry?.contentBoxSize[0]?.inlineSize ?? 0);
    const previousWidthPx = this.#typography.widthPx;
    if (widthPx === previousWidthPx) {
      return;
    }
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const fontSizePx = Number.parseFloat(style?.fontSize ?? "");
    const lineHeightPx = Number.parseFloat(style?.lineHeight ?? "");
    this.#typography = {
      fontSizePx: Number.isFinite(fontSizePx) ? fontSizePx : DEFAULT_BLOCK_TYPOGRAPHY.fontSizePx,
      lineHeightPx: Number.isFinite(lineHeightPx)
        ? lineHeightPx
        : DEFAULT_BLOCK_TYPOGRAPHY.lineHeightPx,
      widthPx,
    };
    const row = element.closest(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`);
    this.#bodyOffsetInRowPx =
      row === null ? 0 : element.getBoundingClientRect().top - row.getBoundingClientRect().top;
    this.#estimates.clear();
    if (previousWidthPx !== undefined) {
      this.#remeasureAtNewWidth();
    }
    this.#resendOffset?.();
  }

  /**
   * Drops every height measured at the old width, since text wraps anew, and measures the drawn
   * blocks again at once, so the window never lays them out at an estimate.
   */
  #remeasureAtNewWidth(): void {
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
    const widthPx = this.#typography.widthPx;
    return block === undefined || widthPx === undefined
      ? undefined
      : { fingerprint: block.fingerprint, widthPx, isFinal: index === this.blockCount - 1 };
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
