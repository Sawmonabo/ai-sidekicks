// The delta-fed block segmenter — where the committed prefix ends and the volatile
// tail begins.
//
// `Spec-023 §Console Design (Meridian)` §5.14: "Markdown renders through a committed
// and volatile split: the committed prefix is memoized and stable, the volatile tail is
// the reveal engine's, and an incomplete construct never mounts." §5.9's leverage line
// puts the segmenter on the OWN-BUILD side, and the measurement in
// `Spec-023 §References` D.2 is why: a whole-message re-parse costs 94.3 ms at 64 KB
// and is linear in length, so re-parsing per token is quadratic over a stream, while a
// 256 B–2 KB tail slice costs 0.30–1.31 ms.
//
// WHAT IT IS FED. The reveal engine publishes CUMULATIVE text for a lane — the whole of
// what may be shown, growing at one end. So the segmenter takes a snapshot rather than
// a delta and answers what changed, which is what lets one card be re-rendered from a
// store read without the segmenter having to have seen every intermediate frame.
//
// WHY A CLASS. It holds the split across frames and it is not a component's state: a
// re-render must not re-split from scratch, and a card that unmounts and remounts must
// not re-parse its whole history. The scan itself is incremental — the boundary search
// resumes from the last committed offset, so a growing message costs its growth rather
// than its length.
//
// THE ONE SUBTLETY: FENCES. A blank line inside a fenced code block is not a block
// boundary, so the scan tracks fence state as it goes. That is not a parser and does not
// try to be one — commonmark's block grammar has more openers than this — it is the one
// construct whose interior contains the boundary character, and getting it wrong splits
// a code block in half and parses each half separately, which is visible and wrong.

import { MARKDOWN_SETTLE_LAG_BLOCKS } from "../card-bounds.js";

/** The split, as a card renders it. */
export interface MarkdownSegmentation {
  /**
   * Complete blocks far enough behind the tail to be final. Each is parsed once and
   * memoised by its own text.
   */
  readonly settledBlocks: readonly string[];
  /**
   * Everything after them: the lagged complete blocks and the incomplete tail, as one
   * string. Re-parsed on every frame, and the only part `remend` is applied to.
   */
  readonly volatileTail: string;
}

/** A fence opener or closer, and the run length that has to be matched to close it. */
interface FenceState {
  readonly marker: string;
  readonly runLength: number;
}

export class MarkdownBlockSegmenter {
  /** Complete blocks, oldest first. Grows only at the end. */
  readonly #completeBlocks: string[] = [];

  /** The snapshot this segmentation was computed from, so growth can be detected. */
  #scannedSource = "";

  /** Where in `#scannedSource` the uncommitted remainder starts. */
  #remainderOffset = 0;

  /**
   * Re-split for a new cumulative snapshot.
   *
   * A snapshot that does not extend the last one — a rollback, a lane rebase, a card
   * handed a different message — resets the scan rather than appending to it. The
   * reveal engine makes the same decision for the same reason: gluing a new history
   * onto the tail of an old one is the one outcome worse than re-doing the work.
   */
  public segment(cumulativeSource: string): MarkdownSegmentation {
    if (!cumulativeSource.startsWith(this.#scannedSource)) {
      this.#reset();
    }
    this.#scanFrom(cumulativeSource);
    this.#scannedSource = cumulativeSource;

    const settledCount = Math.max(0, this.#completeBlocks.length - MARKDOWN_SETTLE_LAG_BLOCKS);
    const settledBlocks = this.#completeBlocks.slice(0, settledCount);
    const laggedBlocks = this.#completeBlocks.slice(settledCount);
    const remainder = cumulativeSource.slice(this.#remainderOffset);
    return {
      settledBlocks,
      volatileTail: withoutLeadingBlankLines([...laggedBlocks, remainder].join("")),
    };
  }

  /** How many complete blocks the scan has found. For the segmenter's own test. */
  public get completeBlockCount(): number {
    return this.#completeBlocks.length;
  }

  #reset(): void {
    this.#completeBlocks.length = 0;
    this.#scannedSource = "";
    this.#remainderOffset = 0;
  }

  /**
   * Walk the uncommitted remainder, closing every block boundary it now contains.
   *
   * The walk starts at `#remainderOffset` rather than at zero, which is what makes the
   * whole thing incremental: text already committed to a block is never re-examined.
   * Fence state is recomputed across the remainder alone, and that is sound because a
   * boundary is only ever committed OUTSIDE a fence — so the remainder always begins at
   * fence depth zero.
   */
  #scanFrom(cumulativeSource: string): void {
    let openFence: FenceState | undefined;
    let lineStart = this.#remainderOffset;
    let blankRunStart: number | undefined;

    while (lineStart < cumulativeSource.length) {
      const newlineIndex = cumulativeSource.indexOf("\n", lineStart);
      if (newlineIndex === -1) {
        // A line with no terminator has not arrived in full; it cannot close a block.
        return;
      }
      const line = cumulativeSource.slice(lineStart, newlineIndex);
      const nextLineStart = newlineIndex + 1;

      if (openFence === undefined) {
        const opener = readFenceMarker(line);
        if (opener !== undefined) {
          openFence = opener;
          blankRunStart = undefined;
          lineStart = nextLineStart;
          continue;
        }
        if (line.trim() === "") {
          blankRunStart ??= lineStart;
          lineStart = nextLineStart;
          continue;
        }
        if (blankRunStart !== undefined) {
          // The blank run behind this line closed the block before it. The block keeps
          // its own trailing blank line so a re-join reproduces the source exactly.
          this.#commitBlock(cumulativeSource.slice(this.#remainderOffset, blankRunStart + 1));
          this.#remainderOffset = blankRunStart + 1;
          blankRunStart = undefined;
        }
        lineStart = nextLineStart;
        continue;
      }

      if (closesFence(line, openFence)) {
        openFence = undefined;
      }
      lineStart = nextLineStart;
    }
  }

  #commitBlock(block: string): void {
    if (block.trim() === "") {
      return;
    }
    this.#completeBlocks.push(block);
  }
}

/**
 * Blank separator lines ahead of the tail's first content line, and nothing more.
 *
 * The block before this tail keeps its own trailing blank line so a re-join reproduces
 * the source, which is why the tail starts on one at all — and dropping the separator
 * is all that is wanted. Trimming leading WHITESPACE instead takes the indentation of
 * the first content line with it, and in commonmark that indentation is syntax: four
 * spaces open an indented code block, so `    command` would arrive at the parser as
 * an ordinary paragraph and a reader would be shown prose where an author wrote code.
 * The class is `[ \t]` rather than `\s` for the same reason the boundary scan is
 * line-oriented: `\s` matches the newline itself and would eat the line's own
 * terminator out of the middle of the run.
 */
function withoutLeadingBlankLines(tail: string): string {
  return tail.replace(/^(?:[ \t]*\n)+/u, "");
}

/** The fence this line opens, or `undefined`. Backticks and tildes, per commonmark. */
function readFenceMarker(line: string): FenceState | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  if (match === null) {
    return undefined;
  }
  const run = match[1];
  if (run === undefined) {
    return undefined;
  }
  const marker = run[0];
  if (marker === undefined) {
    return undefined;
  }
  // A backtick fence's info string may not itself contain a backtick, which is the one
  // case where an apparent opener is ordinary text.
  if (marker === "`" && line.slice(match.index + run.length).includes("`")) {
    return undefined;
  }
  return { marker, runLength: run.length };
}

/** Whether this line closes the open fence: same marker, at least as long, nothing else. */
function closesFence(line: string, openFence: FenceState): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line);
  const run = match?.[1];
  return run !== undefined && run[0] === openFence.marker && run.length >= openFence.runLength;
}
