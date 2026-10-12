// An output read a piece at a time, as a preparation reads it in slices, draws what one read of it
// whole draws, through a run that cannot settle alone.

import { describe, expect, it } from "vitest";

import { publishedTextOf } from "#renderer/features/transcript/reveal/published-text.js";
import { AnsiLineChunks, type AnsiLineChunkList } from "./chunks.js";

/** Built from its code point: a raw control byte in source is invisible in a diff. */
const ESCAPE = String.fromCodePoint(0x1b);

/** More pieces than any read of the case's text takes while it makes progress. */
const PIECE_BOUND = 1_000;

/** `count` lines, each green, then plain, numbered from `first`. */
function coloredLines(first: number, count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `${ESCAPE}[32mok${ESCAPE}[39m line ${String(first + index)}\n`,
  ).join("");
}

/**
 * Each chunk's lines' lengths and its runs, adjacent spans of one style joined: what a reader sees
 * of a chunk, however the reads cut its spans.
 */
function drawnChunks(chunks: AnsiLineChunkList): unknown[] {
  return Array.from({ length: chunks.count }, (_unused, index) => {
    const chunk = chunks.chunkAt(index);
    const runs: { text: string; style: string }[] = [];
    for (const { text, ...style } of chunk.spans) {
      const styleKey = JSON.stringify(style);
      const last = runs.at(-1);
      if (last?.style === styleKey) {
        last.text += text;
      } else {
        runs.push({ text, style: styleKey });
      }
    }
    return { lineLengths: chunk.lineLengths, runs };
  });
}

describe("reading an output a piece at a time", () => {
  it("draws what a whole read draws, reading past a run that opens with no whole sequence", () => {
    // An `ESC [` and a line feed open no whole sequence, so the run after it cannot settle until
    // a later `ESC [` is read with it, far past one piece.
    const plainLines = Array.from(
      { length: 4_000 },
      (_unused, index) => `plain ${String(index)}\n`,
    );
    const text = publishedTextOf(
      `${coloredLines(0, 1_000)}${ESCAPE}[\n${plainLines.join("")}${coloredLines(1_000, 1_000)}`,
    );

    // Far more pieces than the text takes, so a read that stops making progress fails here.
    let wholePieceCount = 1;
    const whole = new AnsiLineChunks().read(text, () => {
      wholePieceCount += 1;
      return wholePieceCount <= PIECE_BOUND;
    });
    const pieced = new AnsiLineChunks();
    let read = pieced.read(text, () => false);
    let pieceCount = 1;
    while (!read.isComplete && pieceCount < PIECE_BOUND) {
      read = pieced.read(text, () => false);
      pieceCount += 1;
    }

    expect(whole.isComplete).toBe(true);
    expect(read.isComplete).toBe(true);
    expect(pieceCount).toBeGreaterThan(3);
    expect(drawnChunks(read.chunks)).toEqual(drawnChunks(whole.chunks));
  });
});
