// A command output's spans grouped into chunks of whole lines, the items its window draws or stands
// a spacer in for. A chunk closes at the line end that brings it to its share of lines or
// characters, and never changes after; only the last chunk grows, holding the lines since and the
// tail the parser reads again on each revision. A revision appends the spans it settled to the
// last chunk, so no revision copies the spans of the chunks before it. The text is read a piece of
// whole lines at a time while the caller's slice has time, so a long output is parsed in slices.

import { type PublishedText } from "#renderer/lib/text/published.js";
import { AnsiSpanParser, type AnsiSpan } from "../spans.js";

/** One chunk of an output's lines, as its window draws it. */
export interface AnsiLineChunk {
  /** The chunk's spans in order; its text ends at a line feed, but for the output's last. */
  readonly spans: readonly AnsiSpan[];
  /** Each of the chunk's lines' length in UTF-16 code units, its line feed left out, in order. */
  readonly lineLengths: readonly number[];
}

/** An output's chunks as one revision reads them. */
export interface AnsiLineChunkList {
  /** Which parse from the start the chunks come from; a rewrite of parsed text starts another. */
  readonly generation: number;
  readonly count: number;
  /** The chunk at `index`, below `count`. */
  chunkAt(index: number): AnsiLineChunk;
}

/** An output's chunks as one read leaves them, and whether that read reached the text's end. */
export interface AnsiLineChunkRead {
  readonly chunks: AnsiLineChunkList;
  /** Whether the chunks hold the whole text read; false when the slice ran out before its end. */
  readonly isComplete: boolean;
}

/** One output's chunks, read from its text as it grows. */
export class AnsiLineChunks {
  readonly #parser = new AnsiSpanParser();
  #generation = 0;
  /** The closed chunks, in order; a new array for each generation, so a held list keeps its own. */
  #closed: AnsiLineChunk[] = [];
  /** The last chunk's settled spans, its lines' lengths, the open line's last, and its size. */
  #openSpans: AnsiSpan[] = [];
  #openLineLengths: number[] = [0];
  #openCharacterCount = 0;
  /**
   * How far the next piece reaches: twice as far after each piece that settled nothing, kept
   * across reads, so a run that cannot settle in one slice's pieces settles in a later slice's.
   */
  #pieceLength = PIECE_LENGTH;

  /**
   * The chunks of `text` as far as this read reaches, reading only past the parsed part, a piece of
   * whole lines at a time, at least one and more while `hasTime` answers true. A rewrite below the
   * parsed part drops every chunk read before it and starts a new generation.
   */
  public read(text: PublishedText, hasTime: () => boolean): AnsiLineChunkRead {
    let tailSpans: readonly AnsiSpan[];
    let isComplete: boolean;
    do {
      const start = this.#parser.parsedLengthOf(text);
      const end = pieceEndOf(text, start + this.#pieceLength);
      const read = this.#parser.read(text, end);
      if (read.restarted) {
        this.#generation += 1;
        this.#closed = [];
        this.#startOpenChunk();
      }
      for (const span of read.settledSpans) {
        this.#appendSettled(span);
      }
      tailSpans = read.tailSpans;
      isComplete = end === text.length;
      // A piece holding one run that opens with no whole sequence settles nothing alone.
      this.#pieceLength =
        this.#parser.parsedLengthOf(text) === start ? this.#pieceLength * 2 : PIECE_LENGTH;
    } while (!isComplete && hasTime());
    return { chunks: this.#listWith(tailSpans), isComplete };
  }

  /** Adds a settled span to the last chunk, closing it at each line end that fills it. */
  #appendSettled(span: AnsiSpan): void {
    const text = span.text;
    let pieceStart = 0;
    let lineStart = 0;
    for (
      let lineEnd = text.indexOf("\n");
      lineEnd !== -1;
      lineEnd = text.indexOf("\n", lineStart)
    ) {
      this.#extendOpenLine(lineEnd - lineStart);
      this.#openCharacterCount += 1;
      this.#openLineLengths.push(0);
      lineStart = lineEnd + 1;
      if (this.#isOpenChunkFull()) {
        this.#openSpans.push(pieceOf(span, pieceStart, lineStart));
        this.#closeOpenChunk();
        pieceStart = lineStart;
      }
    }
    this.#extendOpenLine(text.length - lineStart);
    if (pieceStart < text.length) {
      this.#openSpans.push(pieceOf(span, pieceStart, text.length));
    }
  }

  #extendOpenLine(length: number): void {
    const last = this.#openLineLengths.length - 1;
    this.#openLineLengths[last] = (this.#openLineLengths[last] ?? 0) + length;
    this.#openCharacterCount += length;
  }

  /** Whether the last chunk, standing at a line end, holds its share of lines or characters. */
  #isOpenChunkFull(): boolean {
    // The lengths list holds the empty line just opened past the line end.
    return (
      this.#openLineLengths.length - 1 >= CHUNK_LINE_COUNT ||
      this.#openCharacterCount >= CHUNK_CHARACTER_COUNT
    );
  }

  /** Closes the last chunk at the line end it stands at, and opens an empty one after it. */
  #closeOpenChunk(): void {
    this.#closed.push({ spans: this.#openSpans, lineLengths: this.#openLineLengths.slice(0, -1) });
    this.#startOpenChunk();
  }

  #startOpenChunk(): void {
    this.#openSpans = [];
    this.#openLineLengths = [0];
    this.#openCharacterCount = 0;
  }

  /** The chunks as they stand, the last with `tailSpans` after its settled spans. */
  #listWith(tailSpans: readonly AnsiSpan[]): AnsiLineChunkList {
    const closed = this.#closed;
    // The chunks closed by this revision: a later one closes more, which a held list never shows.
    const closedCount = closed.length;
    const open = openChunkOf(this.#openSpans, this.#openLineLengths, tailSpans);
    const count = closedCount + (open === undefined ? 0 : 1);
    return {
      generation: this.#generation,
      count,
      chunkAt: (index) => {
        const chunk = index < closedCount ? closed[index] : open;
        if (chunk === undefined || index >= count) {
          throw new Error("An output's chunk was read past its last.");
        }
        return chunk;
      },
    };
  }
}

/** The text a chunk holds, its spans joined. */
export function chunkTextOf(chunk: AnsiLineChunk): string {
  return chunk.spans.map((span) => span.text).join("");
}

/** Where a piece reaching `from` ends: just past the line end there, or at the text's end. */
function pieceEndOf(text: PublishedText, from: number): number {
  const lineEnd = from >= text.length ? -1 : text.indexOf("\n", from);
  return lineEnd === -1 ? text.length : lineEnd + 1;
}

/** `span`'s text from `start` to `end`, as a span of its own; the span itself when that is all. */
function pieceOf(span: AnsiSpan, start: number, end: number): AnsiSpan {
  return start === 0 && end === span.text.length
    ? span
    : { ...span, text: span.text.slice(start, end) };
}

/**
 * The last chunk: its settled spans and `tailSpans` after them, with its lines' lengths; a line
 * feed ending it opens no line of its own. `undefined` while it holds no text.
 */
function openChunkOf(
  settledSpans: readonly AnsiSpan[],
  settledLineLengths: readonly number[],
  tailSpans: readonly AnsiSpan[],
): AnsiLineChunk | undefined {
  // A copy of the chunk's own spans, which later revisions append to.
  const spans = [...settledSpans, ...tailSpans];
  if (spans.length === 0) {
    return undefined;
  }
  const lineLengths = [...settledLineLengths];
  for (const span of tailSpans) {
    const lines = span.text.split("\n");
    lineLengths[lineLengths.length - 1] = (lineLengths.at(-1) ?? 0) + (lines[0]?.length ?? 0);
    for (const line of lines.slice(1)) {
      lineLengths.push(line.length);
    }
  }
  if (lineLengths.length > 1 && lineLengths.at(-1) === 0) {
    lineLengths.pop();
  }
  return { spans, lineLengths };
}

/**
 * How many lines a chunk closes at, and how many characters. Small enough that the lines drawn
 * past the reader's view stay within a few screens; large enough that a long output's chunks
 * number in the thousands, not the hundreds of thousands, for the window to lay out.
 */
const CHUNK_LINE_COUNT = 32;
const CHUNK_CHARACTER_COUNT = 4_096;

/**
 * How many characters one piece of a read reaches before the line end it stops at: a few hundred
 * microseconds of parsing, so a slice stops close to its end.
 */
const PIECE_LENGTH = 16_384;
