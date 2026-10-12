// An output's window over its chunks of lines: the type its estimates read and the place of its
// lines in their row, around the measured window every nested window of blocks in flow shares.
// Drawn chunks sit in flow as blocks of their own lines, so each line wraps and stands as the whole
// output draws it; a spacer holds the room of each run of undrawn chunks, estimated from their
// lines' lengths at the output's width and line height until each chunk is measured, drawn or off
// screen in a slice of its own.

import type { Unsubscribe } from "#shared/preload-api.js";
import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import { MeasuredItemWindow } from "#renderer/components/TranscriptBodyViewport/measured-item-window.js";
import { offsetInRowPx } from "#renderer/components/TranscriptBodyViewport/scroller-window.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { inheritedTextStyleOf } from "#renderer/lib/off-screen-measurement.js";
import { type AnsiLineChunk, type AnsiLineChunkList } from "./chunks.js";
import { ANSI_LINE_CHUNK_INDEX_ATTRIBUTE } from "./markers.js";

/** One output's window layout: its measured window, and the type and place its lines are read at. */
export class AnsiLineWindowLayout {
  #chunks: AnsiLineChunkList;
  #linesElement: HTMLElement | undefined;
  #stopObservingLines: Unsubscribe | undefined;
  /** The lines' width, line height and face, read from their resize observations. */
  #type: AnsiLinesType | undefined;
  /** How far the lines' top sits below their row's, read each time the lines resize. */
  #offsetInRowPx = 0;
  /** The closed chunks' estimates at the current type, by index; the last chunk still grows. */
  readonly #estimates = new Map<number, number>();

  /** The window over the output's chunks, laid out against the conversation scroller. */
  public readonly window: MeasuredItemWindow<AnsiLineChunk>;

  /** The lines' element: what the window observes its chunks from. Never scrolled. */
  public readonly getScrollElement = (): HTMLElement | null => this.#linesElement ?? null;

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

  /**
   * Reads the lines' type as they first mount, with the other layout reads of the commit, so the
   * window draws its chunks before the first frame paints; answers whether it read one.
   */
  public readonly readTypeOnMount = (): boolean => {
    const element = this.#linesElement;
    if (element === undefined || this.#type !== undefined) {
      return false;
    }
    this.#type = readLinesType(element, element.getBoundingClientRect().width, undefined);
    this.#offsetInRowPx = offsetInRowPx(element);
    return true;
  };

  /** `viewport` and `rowKey` are held for the layout's life. */
  public constructor(viewport: TranscriptBodyViewport, rowKey: string, chunks: AnsiLineChunkList) {
    this.#chunks = chunks;
    this.window = new MeasuredItemWindow(
      viewport,
      rowKey,
      {
        itemCount: () => this.#chunks.count,
        itemAt: (index) => this.#chunks.chunkAt(index),
        estimateSize: this.estimateSize,
        readBox: () => {
          const element = this.#linesElement;
          const type = this.#type;
          return element === undefined || type === undefined
            ? undefined
            : {
                ownerDocument: element.ownerDocument,
                widthPx: type.widthPx,
                textStyle: type.textStyle,
              };
        },
        offsetInRowPx: () => this.#offsetInRowPx,
      },
      ANSI_LINE_CHUNK_INDEX_ATTRIBUTE,
    );
  }

  /** Whether the lines' type is read, which every estimate needs: the window lays out from then. */
  public get isLaidOut(): boolean {
    return this.#type !== undefined;
  }

  /** Takes the output's chunks for this frame. */
  public setChunks(chunks: AnsiLineChunkList): void {
    this.#chunks = chunks;
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
      this.window.retype(previousType !== undefined);
    }
    if (offsetInRow !== this.#offsetInRowPx || type !== previousType) {
      this.#offsetInRowPx = offsetInRow;
      this.window.resendOffset();
    }
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
  const textStyle = inheritedTextStyleOf(style);
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
