// The members an output's virtualizer is built with, and the state behind them. The window
// lays the output's chunks of lines out against the conversation scroller through
// `ScrollerWindowMembers`, from the top of the output's lines in the scroller's content, read from
// its row's top and the lines' place in the row. Drawn chunks sit in flow as blocks of their own
// lines, so each line wraps and stands as the whole output draws it; a spacer holds the room of
// each run of undrawn chunks, estimated from their lines' lengths at the output's width and line
// height until each chunk is measured, drawn or off screen in a slice of its own.

import type { Range, VirtualItem, Virtualizer } from "@tanstack/virtual-core";

import type { Unsubscribe } from "#shared/preload-api.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { type DrawnBandScreenHeights } from "#renderer/features/transcript/viewport/drawn-band.js";
import { type MarkdownWindowViewport } from "../../markdown/block-window/context.js";
import { ReaderPlaceHold } from "../../markdown/reader-place-hold.js";
import { offsetInRowPx, ScrollerWindowMembers } from "../../markdown/scroller-window.js";
import { type AnsiLineChunk, type AnsiLineChunkList } from "./chunks.js";
import {
  AnsiChunkMeasurement,
  linesTextStyleOf,
  type AnsiIndexedChunk,
  type AnsiMeasuredChunkHeight,
} from "./measurement.js";

/** The virtualizer an output's window runs, over its lines' element and its drawn chunks. */
export type AnsiLineVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/** One element of an output's window, in document order. */
export type AnsiLineWindowRow =
  | { readonly kind: "chunk"; readonly key: string; readonly index: number }
  | {
      /** The room of a run of undrawn chunks, first to last, where flow would lay them out. */
      readonly kind: "spacer";
      readonly key: string;
      readonly heightPx: number;
      readonly firstIndex: number;
      readonly lastIndex: number;
    };

/**
 * One output's window layout: the stable option members its virtualizer reads, the type its
 * estimates read, and the place of the output's lines in the scroller.
 */
export class AnsiLineWindowLayout {
  readonly #viewport: MarkdownWindowViewport;
  readonly #rowKey: string;
  readonly #scroller: ScrollerWindowMembers;
  readonly #placeHold: ReaderPlaceHold;
  #chunks: AnsiLineChunkList;
  #linesElement: HTMLElement | undefined;
  #stopObservingLines: Unsubscribe | undefined;
  #virtualizer: AnsiLineVirtualizer | undefined;
  /** The lines' width, line height and face, read from their resize observations. */
  #type: AnsiLinesType | undefined;
  /** How far the lines' top sits below their row's, read each time the lines resize. */
  #offsetInRowPx = 0;
  /** The row's last known top, kept for a geometry sample taken while the viewport lets it go. */
  #rowStartPx = 0;
  /** The closed chunks' estimates at the current type, by index; the last chunk still grows. */
  readonly #estimates = new Map<number, number>();
  /** The rows the output last committed to the page. */
  #committedRows: readonly AnsiLineWindowRow[] = [];
  /** The chunk whose height the virtualizer holds at each index, measured at the current type. */
  #measuredChunks: (AnsiLineChunk | undefined)[] = [];
  #isTakingHeights = false;

  /** The off-screen measurement of the chunks the window has not measured drawn. */
  public readonly measurement: AnsiChunkMeasurement = new AnsiChunkMeasurement({
    readLines: () => {
      const element = this.#linesElement;
      const type = this.#type;
      return element === undefined || type === undefined || this.#virtualizer === undefined
        ? undefined
        : {
            ownerDocument: element.ownerDocument,
            widthPx: type.widthPx,
            textStyle: type.textStyle,
          };
    },
    readUnmeasuredChunks: (count) => this.#unmeasuredChunks(count),
    takeHeights: (heights) => {
      this.#takeHeights(heights);
    },
  });

  /** The lines' element: what the window observes its chunks from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#linesElement ?? null;

  /** The window's offset, viewport and refused writes, against the conversation scroller. */
  public readonly scrollToFn: ScrollerWindowMembers["scrollToFn"];
  public readonly observeElementOffset: ScrollerWindowMembers["observeElementOffset"];
  public readonly observeElementRect: ScrollerWindowMembers["observeElementRect"];
  public readonly initialOffset: ScrollerWindowMembers["initialOffset"];

  /** A chunk's estimated room: each line's wrapped rows at the lines' width, a line height each. */
  public readonly estimateSize = (index: number): number => {
    const held = this.#estimates.get(index);
    if (held !== undefined) {
      return held;
    }
    const type = this.#type;
    if (type === undefined) {
      throw new Error("An output's chunk was estimated before its lines were laid out.");
    }
    const estimate = estimateChunkHeightPx(this.#chunks.chunkAt(index), type);
    if (index < this.#chunks.count - 1) {
      this.#estimates.set(index, estimate);
    }
    return estimate;
  };

  /**
   * A chunk's room when it resizes: the observer's border box, unrounded, so spacers add up to what
   * flow lays out. With no observation, as a chunk mounts, it answers what it last held.
   */
  public readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: AnsiLineVirtualizer,
  ): number => {
    const index = instance.indexFromElement(element);
    const measuredPx = entry?.borderBoxSize[0]?.blockSize;
    if (measuredPx !== undefined) {
      this.#markMeasured(index);
      return measuredPx;
    }
    return (
      instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? this.estimateSize(index)
    );
  };

  /**
   * The library's question whether to move the offset for a chunk that resized, always answered
   * no: its write would land on the lines, which never scroll. A chunk wholly above the scroller's
   * top, in a row the output holds the reader's place inside, moves the conversation by its change
   * instead, so the lines being read stay where they are.
   */
  public readonly holdPlaceThroughResizedChunk = (
    item: VirtualItem,
    deltaPx: number,
    instance: AnsiLineVirtualizer,
  ): boolean => {
    if (
      item.end <= (instance.scrollOffset ?? 0) &&
      this.#viewport.holdsPlaceInsideRow(this.#rowKey)
    ) {
      this.#placeHold.add(deltaPx);
    }
    return false;
  };

  /** The lines' element, and its size observation: its width, type and place in its row. */
  public readonly attachLines = (element: HTMLElement | null): void => {
    this.#stopObservingLines?.();
    this.#stopObservingLines = undefined;
    this.#linesElement = element ?? undefined;
    if (element !== null) {
      this.#stopObservingLines = observeElementResize(element, (entries) => {
        this.#readLines(element, entries.at(-1));
      });
    }
  };

  /** `viewport` and `rowKey` are held for the layout's life. */
  public constructor(viewport: MarkdownWindowViewport, rowKey: string, chunks: AnsiLineChunkList) {
    this.#viewport = viewport;
    this.#rowKey = rowKey;
    this.#chunks = chunks;
    const scroller = new ScrollerWindowMembers(viewport.scrollController, () => this.#linesTopPx());
    this.#scroller = scroller;
    this.#placeHold = new ReaderPlaceHold(viewport.scrollController);
    this.scrollToFn = scroller.scrollToFn;
    this.observeElementOffset = scroller.observeElementOffset;
    this.observeElementRect = scroller.observeElementRect;
    this.initialOffset = scroller.initialOffset;
  }

  /** How many chunks the window lays out. */
  public get chunkCount(): number {
    return this.#chunks.count;
  }

  /** Whether the lines' type is read, which every estimate needs: the window lays out from then. */
  public get isLaidOut(): boolean {
    return this.#type !== undefined;
  }

  /**
   * Whether heights measured off screen are being handed to the virtualizer, whose changes are
   * then told once, after the last.
   */
  public get isTakingHeights(): boolean {
    return this.#isTakingHeights;
  }

  /**
   * Reads the lines' type as they first mount, with the other layout reads of the commit, so the
   * window draws its chunks before the first frame paints; answers whether it read one.
   */
  public readTypeOnMount(): boolean {
    const element = this.#linesElement;
    if (element === undefined || this.#type !== undefined) {
      return false;
    }
    this.#type = readLinesType(element, element.getBoundingClientRect().width, undefined);
    this.#offsetInRowPx = offsetInRowPx(element);
    return true;
  }

  /** Takes the output's chunks for this frame. */
  public setChunks(chunks: AnsiLineChunkList): void {
    this.#chunks = chunks;
  }

  /** The chunks drawn for the library's `range`: on screen, and `bandScreenHeights` past them. */
  public drawnIndexesOf(range: Range, bandScreenHeights: DrawnBandScreenHeights): number[] {
    return this.#scroller.drawnIndexesOf(
      range,
      bandScreenHeights,
      (index) => this.#virtualizer?.measurementsCache[index]?.size ?? this.estimateSize(index),
    );
  }

  /** Takes the virtualizer this layout's members were given to, which a new type re-measures. */
  public bindVirtualizer(virtualizer: AnsiLineVirtualizer): void {
    this.#virtualizer = virtualizer;
  }

  /** The viewport the window opens against before its first geometry sample. */
  public initialRect(): ReturnType<ScrollerWindowMembers["initialRect"]> {
    return this.#scroller.initialRect();
  }

  /**
   * The output's elements in document order: each drawn chunk, with a spacer for each run of
   * undrawn chunks before, between and after them, as tall as the window lays that run out.
   */
  public windowRows(
    virtualItems: readonly VirtualItem[],
    totalSizePx: number,
  ): AnsiLineWindowRow[] {
    const rows: AnsiLineWindowRow[] = [];
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
      rows.push({ kind: "chunk", key: String(item.key), index: item.index });
      previousEndPx = item.end;
      previousIndex = item.index;
    }
    const lastIndex = this.#chunks.count - 1;
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

  /** Takes the rows the output has just drawn. */
  public commitRows(rows: readonly AnsiLineWindowRow[]): void {
    this.#committedRows = rows;
  }

  /**
   * Whether the rows for these items differ from the ones on the page: a chunk measured anew moves
   * the spacers around it without changing which chunks are drawn.
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

  /** The lines' top in the scroller's content: their row's top, and their place in the row. */
  #linesTopPx(): number {
    this.#rowStartPx = this.#viewport.rowStartPx(this.#rowKey) ?? this.#rowStartPx;
    return this.#rowStartPx + this.#offsetInRowPx;
  }

  /**
   * Reads the lines each time they resize, the first observation included: their place in their
   * row, which a running command's tail moves as it grows, and their type, which a new width or
   * text size changes, the estimates and the drawn chunks' heights taken again.
   */
  #readLines(element: HTMLElement, entry: ResizeObserverEntry | undefined): void {
    const offsetInRow = offsetInRowPx(element);
    const type = readLinesType(element, entry?.contentBoxSize[0]?.inlineSize ?? 0, this.#type);
    const previousType = this.#type;
    if (!isSameLinesType(type, previousType)) {
      this.#type = type;
      this.#estimates.clear();
      this.#measuredChunks = [];
      if (previousType !== undefined) {
        this.#remeasureAtNewType();
      }
      this.measurement.stop();
      this.measurement.measure();
    }
    if (offsetInRow !== this.#offsetInRowPx || type !== previousType) {
      this.#offsetInRowPx = offsetInRow;
      this.#scroller.resendOffset();
    }
  }

  /**
   * Drops every height measured at the old type, since the lines wrap anew, and measures the drawn
   * chunks again at once, so the window never lays them out at an estimate.
   */
  #remeasureAtNewType(): void {
    const virtualizer = this.#virtualizer;
    if (virtualizer === undefined) {
      return;
    }
    virtualizer.measure();
    for (const element of virtualizer.elementsCache.values()) {
      if (element.isConnected) {
        const index = virtualizer.indexFromElement(element);
        this.#markMeasured(index);
        virtualizer.resizeItem(index, element.getBoundingClientRect().height);
      }
    }
  }

  /** Notes that the virtualizer holds the height of the chunk now at `index`. */
  #markMeasured(index: number): void {
    if (index < this.#chunks.count) {
      this.#measuredChunks[index] = this.#chunks.chunkAt(index);
    }
  }

  /**
   * The first `count` chunks whose height the virtualizer does not hold, in order. A drawn chunk's
   * is held, as its resize observation reports each change, so a growing last chunk drawn on screen
   * is never measured again off screen.
   */
  #unmeasuredChunks(count: number): AnsiIndexedChunk[] {
    const chunks: AnsiIndexedChunk[] = [];
    for (let index = 0; index < this.#chunks.count && chunks.length < count; index += 1) {
      const chunk = this.#chunks.chunkAt(index);
      if (this.#measuredChunks[index] === chunk) {
        continue;
      }
      if (this.#isDrawn(index)) {
        this.#measuredChunks[index] = chunk;
      } else {
        chunks.push({ index, chunk });
      }
    }
    return chunks;
  }

  /** Whether chunk `index` is drawn in the output's lines now, observed as it resizes. */
  #isDrawn(index: number): boolean {
    const virtualizer = this.#virtualizer;
    return (
      virtualizer?.elementsCache.get(virtualizer.options.getItemKey(index))?.isConnected === true
    );
  }

  /**
   * Hands the virtualizer the heights measured off screen of the chunks still standing as they
   * were drawn, then tells its change once: a chunk the output grew since is measured again.
   */
  #takeHeights(heights: readonly AnsiMeasuredChunkHeight[]): void {
    const virtualizer = this.#virtualizer;
    if (virtualizer === undefined) {
      return;
    }
    this.#isTakingHeights = true;
    try {
      for (const { index, chunk, heightPx } of heights) {
        if (index < this.#chunks.count && this.#chunks.chunkAt(index) === chunk) {
          this.#measuredChunks[index] = chunk;
          virtualizer.resizeItem(index, heightPx);
        }
      }
    } finally {
      this.#isTakingHeights = false;
    }
    virtualizer.options.onChange?.(virtualizer, false);
  }
}

/** How an output's lines are set: their width, line height and face, and a character's advance. */
interface AnsiLinesType {
  readonly widthPx: number;
  readonly lineHeightPx: number;
  readonly font: string;
  /**
   * One digit's advance in the face; every character is taken as one, exact in a monospace face
   * and an estimate in a proportional one, until the chunk is measured.
   */
  readonly advancePx: number;
  /** The lines' type as computed CSS declarations, which a frame outside their row is set in. */
  readonly textStyle: string;
}

/**
 * The lines' type at `widthPx`, read from their computed style; the advance is measured on the
 * document's one canvas only when the face changed from `held`'s. Throws where no canvas can
 * measure.
 */
function readLinesType(
  element: HTMLElement,
  widthPx: number,
  held: AnsiLinesType | undefined,
): AnsiLinesType {
  const style = getComputedStyle(element);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const lineHeightPx = parseFloat(style.lineHeight);
  const textStyle = linesTextStyleOf(style);
  if (held !== undefined && held.font === font) {
    return { widthPx, lineHeightPx, font, advancePx: held.advancePx, textStyle };
  }
  const context = advanceCanvases.contextOf(element.ownerDocument);
  context.font = font;
  const advancePx = context.measureText(ADVANCE_SAMPLE).width / ADVANCE_SAMPLE.length;
  return { widthPx, lineHeightPx, font, advancePx, textStyle };
}

/** One canvas per document that outputs' faces are measured on, made when first asked. */
class AdvanceCanvases {
  readonly #contexts = new WeakMap<Document, CanvasRenderingContext2D>();

  /** The canvas context of `ownerDocument`. Throws where no canvas can measure. */
  public contextOf(ownerDocument: Document): CanvasRenderingContext2D {
    const held = this.#contexts.get(ownerDocument);
    if (held !== undefined) {
      return held;
    }
    const context = ownerDocument.createElement("canvas").getContext("2d");
    if (context === null) {
      throw new Error("A canvas could not measure an output's lines.");
    }
    this.#contexts.set(ownerDocument, context);
    return context;
  }
}

const advanceCanvases = new AdvanceCanvases();

/** Characters enough that one advance reads past the canvas's rounding. */
const ADVANCE_SAMPLE = "0".repeat(64);

function isSameLinesType(type: AnsiLinesType, held: AnsiLinesType | undefined): boolean {
  return (
    held !== undefined &&
    held.widthPx === type.widthPx &&
    held.lineHeightPx === type.lineHeightPx &&
    held.font === type.font
  );
}

/**
 * A chunk's estimated height: each line as many rows as its characters fill at the lines' width,
 * at least one, a line height each.
 */
function estimateChunkHeightPx(chunk: AnsiLineChunk, type: AnsiLinesType): number {
  const columns = Math.max(1, Math.floor(type.widthPx / type.advancePx));
  let rows = 0;
  for (const length of chunk.lineLengths) {
    rows += Math.max(1, Math.ceil(length / columns));
  }
  return rows * type.lineHeightPx;
}

function isSameRow(row: AnsiLineWindowRow, held: AnsiLineWindowRow | undefined): boolean {
  if (row.kind === "spacer") {
    return (
      held?.kind === "spacer" &&
      held.key === row.key &&
      held.heightPx === row.heightPx &&
      held.firstIndex === row.firstIndex &&
      held.lastIndex === row.lastIndex
    );
  }
  return held?.kind === "chunk" && held.key === row.key;
}
