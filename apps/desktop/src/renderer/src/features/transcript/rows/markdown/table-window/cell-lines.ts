// The lines one table cell's text fills at one width, filled as the browser fills them, and the
// height they take. Text arrives as segments, each ending where a line may break: after a space,
// an ideograph or a hyphen inside a word. A segment that fits on no line breaks between any two of
// its characters, which `overflow-wrap: anywhere` allows only where the line has no other place.
// Each line is as tall as the tallest kind of line its characters hold.

import { type TableLineKind } from "#renderer/components/Markdown/table-offer.js";

/** The height of a line holding each kind of text, in CSS pixels. */
export type TableLineHeights = Readonly<Record<TableLineKind, number>>;

/**
 * One cell's lines at one width: started at a width, then fed its characters in order, it answers
 * their height. One is reused cell after cell, so a table's cells are measured without garbage.
 */
export class CellLines {
  readonly #lineHeightsPx: TableLineHeights;
  #widthPx = 0;
  /** The height of the lines filled before the current one. */
  #filledHeightPx = 0;
  #lineHeightPx = 0;
  #linePx = 0;
  /** Whether the line may break where its text now ends. */
  #canBreak = false;
  /**
   * The segment being read: its first `#segmentLength` characters' advances, a span's edges in,
   * and their lines' heights, in buffers that grow and are kept.
   */
  #segmentAdvancesPx: Float64Array = new Float64Array(SEGMENT_BUFFER_LENGTH);
  #segmentHeightsPx: Float64Array = new Float64Array(SEGMENT_BUFFER_LENGTH);
  #segmentLength = 0;
  #segmentPx = 0;
  #segmentHeightPx = 0;
  /** How many characters the word being read holds so far, across its segments. */
  #wordLength = 0;

  public constructor(lineHeightsPx: TableLineHeights) {
    this.#lineHeightsPx = lineHeightsPx;
  }

  /** Starts a cell's lines, empty, at `widthPx` of text width, a fit tolerance included. */
  public start(widthPx: number): void {
    this.#widthPx = widthPx;
    this.#filledHeightPx = 0;
    this.#lineHeightPx = this.#lineHeightsPx.plain;
    this.#linePx = 0;
    this.#canBreak = false;
    this.#wordLength = 0;
  }

  /** Whether the character just added began its word; a hyphen there breaks no line after it. */
  public get isWordStart(): boolean {
    return this.#wordLength === 1;
  }

  public addCharacter(advancePx: number, kind: TableLineKind): void {
    const heightPx = this.#lineHeightsPx[kind];
    if (this.#segmentLength === this.#segmentAdvancesPx.length) {
      this.#segmentAdvancesPx = grown(this.#segmentAdvancesPx);
      this.#segmentHeightsPx = grown(this.#segmentHeightsPx);
    }
    this.#segmentAdvancesPx[this.#segmentLength] = advancePx;
    this.#segmentHeightsPx[this.#segmentLength] = heightPx;
    this.#segmentLength += 1;
    this.#segmentPx += advancePx;
    this.#segmentHeightPx = Math.max(this.#segmentHeightPx, heightPx);
    this.#wordLength += 1;
  }

  /** Adds a span's closing edge to the character it follows. */
  public addEdge(edgePx: number): void {
    const last = this.#segmentLength - 1;
    if (last >= 0) {
      this.#segmentAdvancesPx[last] = (this.#segmentAdvancesPx[last] ?? 0) + edgePx;
      this.#segmentPx += edgePx;
    }
  }

  /** Ends the segment at a place a line may break after it. */
  public endSegment(): void {
    this.#placeSegment(true);
  }

  /** A space ending a line hangs past it, so only a space inside the line takes room. */
  public placeSpace(advancePx: number): void {
    this.#placeSegment(true);
    this.#linePx += advancePx;
    this.#canBreak = true;
    this.#wordLength = 0;
  }

  public breakLine(): void {
    this.#placeSegment(false);
    this.#startLine();
    this.#canBreak = false;
    this.#wordLength = 0;
  }

  /** The height of every line the text filled, its last segment placed. */
  public finish(): number {
    this.#placeSegment(false);
    return this.#filledHeightPx + this.#lineHeightPx;
  }

  #startLine(): void {
    this.#filledHeightPx += this.#lineHeightPx;
    this.#lineHeightPx = this.#lineHeightsPx.plain;
    this.#linePx = 0;
  }

  #placeSegment(opensBreak: boolean): void {
    if (this.#segmentLength === 0) {
      return;
    }
    if (this.#canBreak && this.#linePx + this.#segmentPx > this.#widthPx) {
      this.#startLine();
    }
    if (this.#linePx + this.#segmentPx <= this.#widthPx) {
      this.#linePx += this.#segmentPx;
      this.#lineHeightPx = Math.max(this.#lineHeightPx, this.#segmentHeightPx);
      this.#canBreak = opensBreak;
    } else {
      let charactersOnLine = Number.POSITIVE_INFINITY;
      for (let index = 0; index < this.#segmentLength; index += 1) {
        const advancePx = this.#segmentAdvancesPx[index] ?? 0;
        if (this.#linePx > 0 && this.#linePx + advancePx > this.#widthPx) {
          this.#startLine();
          charactersOnLine = 0;
        }
        this.#linePx += advancePx;
        this.#lineHeightPx = Math.max(this.#lineHeightPx, this.#segmentHeightsPx[index] ?? 0);
        charactersOnLine += 1;
      }
      // A hyphen left alone at a line's start begins a word there, and no line breaks after it.
      this.#canBreak = opensBreak && charactersOnLine !== 1;
    }
    this.#segmentLength = 0;
    this.#segmentPx = 0;
    this.#segmentHeightPx = 0;
  }
}

/** The characters a segment buffer holds before it first grows: a long word's worth. */
const SEGMENT_BUFFER_LENGTH = 64;

/** `buffer` copied into one twice as long. */
function grown(buffer: Float64Array): Float64Array {
  const longer = new Float64Array(2 * buffer.length);
  longer.set(buffer);
  return longer;
}
