// The lines one table cell's text fills at one width, filled as the browser fills them, and the
// height they take. Text arrives as segments, each ending where a line may break: after a space,
// an ideograph or a hyphen inside a word. A segment that fits on no line breaks between any two of
// its characters, which `overflow-wrap: anywhere` allows only where the line has no other place.
// Each line is as tall as the tallest kind of line its characters hold.

import { type TableLineKind } from "#renderer/components/Markdown/table-offer.js";

/** The height of a line holding each kind of text, in CSS pixels. */
export type TableLineHeights = Readonly<Record<TableLineKind, number>>;

/** One cell's lines at one width: fed its characters in order, it answers their height. */
export class CellLines {
  readonly #widthPx: number;
  readonly #lineHeightsPx: TableLineHeights;
  /** The height of the lines filled before the current one. */
  #filledHeightPx = 0;
  #lineHeightPx: number;
  #linePx = 0;
  /** Whether the line may break where its text now ends. */
  #canBreak = false;
  /** The segment being read: each character's advance, a span's edges in, and its line's height. */
  readonly #segmentAdvancesPx: number[] = [];
  readonly #segmentHeightsPx: number[] = [];
  #segmentPx = 0;
  #segmentHeightPx = 0;
  /** How many characters the word being read holds so far, across its segments. */
  #wordLength = 0;

  /** `widthPx` is the text's width, a fit tolerance included. */
  public constructor(widthPx: number, lineHeightsPx: TableLineHeights) {
    this.#widthPx = widthPx;
    this.#lineHeightsPx = lineHeightsPx;
    this.#lineHeightPx = lineHeightsPx.plain;
  }

  /** Whether the character just added began its word; a hyphen there breaks no line after it. */
  public get isWordStart(): boolean {
    return this.#wordLength === 1;
  }

  public addCharacter(advancePx: number, kind: TableLineKind): void {
    const heightPx = this.#lineHeightsPx[kind];
    this.#segmentAdvancesPx.push(advancePx);
    this.#segmentHeightsPx.push(heightPx);
    this.#segmentPx += advancePx;
    this.#segmentHeightPx = Math.max(this.#segmentHeightPx, heightPx);
    this.#wordLength += 1;
  }

  /** Adds a span's closing edge to the character it follows. */
  public addEdge(edgePx: number): void {
    const last = this.#segmentAdvancesPx.length - 1;
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
    if (this.#segmentAdvancesPx.length === 0) {
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
      for (const [index, advancePx] of this.#segmentAdvancesPx.entries()) {
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
    this.#segmentAdvancesPx.length = 0;
    this.#segmentHeightsPx.length = 0;
    this.#segmentPx = 0;
    this.#segmentHeightPx = 0;
  }
}
