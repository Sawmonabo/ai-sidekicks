// Splits the reveal engine's cumulative text into settled blocks and a volatile tail. Own-built
// because re-parsing the whole message per token is quadratic: measured, a whole-message re-parse
// costs 94.3 ms at 64 KB and grows linearly, while a 256 B-2 KB tail slice costs 0.30-1.31 ms.
// The segmenter takes a snapshot, not a delta, so a card can re-render from a store read.

import { MARKDOWN_SETTLE_LAG_BLOCKS } from "./segmentation-measures.js";

/** The split, as a card renders it. */
export interface MarkdownSegmentation {
  /** Complete blocks far enough behind the tail to be final; each is read once, as it settles. */
  readonly settledBlocks: readonly string[];
  /** Everything after them, as one string: read every frame, the only part `remend` sees. */
  readonly volatileTail: string;
  /**
   * Counts the scans restarted from nothing. Within one generation a block never changes at its
   * index, so a reader keeping state per block reuses it instead of comparing every block again.
   */
  readonly generation: number;
}

/** What a caller knows about the snapshot beyond its text. */
export interface MarkdownSegmentationOptions {
  /**
   * Whether this snapshot is the body's last. Everything otherwise held back against a later
   * character is then settled and the tail is empty; without it a finished body keeps its last
   * two blocks volatile and routes complete text through `remend`, which would close a
   * construct its author left open on purpose.
   */
  readonly isFinal: boolean;
}

/** A fence opener or closer, and the run length that has to be matched to close it. */
interface FenceState {
  readonly marker: string;
  readonly runLength: number;
}

/**
 * What the current block opened as, where that decides whether a blank line ends it. A blank
 * line is not always a boundary: fenced code, indented code and a list item (a loose list) hold
 * blank lines inside themselves, and splitting there would parse each half with no memory of
 * the other. Fences carry their own state; these are the other two. A blockquote needs none,
 * since a `>`-prefixed blank line does not trim to empty.
 */
type BlockContainer = { readonly kind: "indented-code" } | ListContainer;

/** The list arm of that set. */
interface ListContainer {
  readonly kind: "list";
  /** Columns of indent the marker itself sat at, so a sibling can be recognized. */
  readonly markerIndent: number;
  /**
   * A bullet character or an ordered list's `.` / `)`. Commonmark starts a new list when it
   * changes, which is what separates a sibling item from a different list.
   */
  readonly markerDelimiter: string;
  /** Columns a continuation line of this item has to reach. */
  readonly continuationIndent: number;
}

/** Where an indented code block begins, in columns. Commonmark's own figure. */
const INDENTED_CODE_INDENT = 4;

/** How many columns a tab advances. Commonmark's tab stop. */
const TAB_STOP_COLUMNS = 4;

/**
 * A bullet or ordered list marker, with the whitespace that separates it from content. The
 * trailing `[ \t]+|$` keeps `-a` out; ordered markers cap at nine digits, commonmark's limit.
 */
const LIST_MARKER = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))([ \t]+|$)/u;

/**
 * Holds the split across frames, so a re-render or a remount does not re-split from scratch. The
 * scan resumes from the last committed offset, so a growing message costs its growth.
 */
export class MarkdownBlockSegmenter {
  /** Complete blocks, oldest first. Grows only at the end. */
  readonly #completeBlocks: string[] = [];

  /** The snapshot this segmentation was computed from, so growth can be detected. */
  #scannedSource = "";
  /** Where in `#scannedSource` the uncommitted remainder starts. */
  #remainderOffset = 0;
  #generation = 0;

  /**
   * Re-splits for a new cumulative snapshot. One that does not extend the last (a rollback, a
   * rebase, a different message) resets the scan: gluing a new history onto an old tail is
   * worse than redoing the work.
   */
  public segment(
    cumulativeSource: string,
    options: MarkdownSegmentationOptions = { isFinal: false },
  ): MarkdownSegmentation {
    if (!cumulativeSource.startsWith(this.#scannedSource)) {
      this.#reset();
    }
    this.#scanFrom(cumulativeSource, options.isFinal);
    this.#scannedSource = cumulativeSource;

    if (options.isFinal) {
      // The lag is lifted: the scan already committed the remainder, so every block is final.
      return {
        settledBlocks: [...this.#completeBlocks],
        volatileTail: "",
        generation: this.#generation,
      };
    }

    const settledCount = Math.max(0, this.#completeBlocks.length - MARKDOWN_SETTLE_LAG_BLOCKS);
    const settledBlocks = this.#completeBlocks.slice(0, settledCount);
    const laggedBlocks = this.#completeBlocks.slice(settledCount);
    const remainder = cumulativeSource.slice(this.#remainderOffset);
    return {
      settledBlocks,
      volatileTail: withoutLeadingBlankLines([...laggedBlocks, remainder].join("")),
      generation: this.#generation,
    };
  }

  #reset(): void {
    this.#generation += 1;
    this.#completeBlocks.length = 0;
    this.#scannedSource = "";
    this.#remainderOffset = 0;
  }

  /**
   * Walks the uncommitted remainder, closing every block boundary it now contains. It starts at
   * `#remainderOffset`, so committed text is never re-examined; fence state is recomputed across
   * the remainder alone, which is sound because a boundary is only committed outside a fence.
   * On a final snapshot the trailing blank run is a boundary and the unterminated last line is
   * the author's last line.
   */
  #scanFrom(cumulativeSource: string, isFinal: boolean): void {
    let openFence: FenceState | undefined;
    let lineStart = this.#remainderOffset;
    let blankRunStart: number | undefined;
    let openContainer: BlockContainer | undefined;
    let blockHasContent = false;

    while (lineStart < cumulativeSource.length) {
      const newlineIndex = cumulativeSource.indexOf("\n", lineStart);
      if (newlineIndex === -1 && !isFinal) {
        // A line with no terminator has not arrived in full; it cannot close a block.
        break;
      }
      // On a final snapshot the last line is complete without a terminator.
      const lineEnd = newlineIndex === -1 ? cumulativeSource.length : newlineIndex;
      const line = cumulativeSource.slice(lineStart, lineEnd);
      const nextLineStart = lineEnd + 1;

      if (openFence === undefined) {
        const opener = readFenceMarker(line);
        if (opener !== undefined) {
          openFence = opener;
          blankRunStart = undefined;
          if (!blockHasContent) {
            openContainer = readBlockContainer(line);
            blockHasContent = true;
          }
          lineStart = nextLineStart;
          continue;
        }
        if (line.trim() === "") {
          blankRunStart ??= lineStart;
          lineStart = nextLineStart;
          continue;
        }
        if (blankRunStart !== undefined && !continuesContainer(openContainer, line)) {
          // The blank run closed the block before it; the block keeps its trailing blank line
          // so a re-join reproduces the source.
          this.#commitBlock(cumulativeSource.slice(this.#remainderOffset, blankRunStart + 1));
          this.#remainderOffset = blankRunStart + 1;
          blockHasContent = false;
        }
        blankRunStart = undefined;
        if (!blockHasContent) {
          openContainer = readBlockContainer(line);
          blockHasContent = true;
        }
        lineStart = nextLineStart;
        continue;
      }

      if (closesFence(line, openFence)) {
        openFence = undefined;
      }
      lineStart = nextLineStart;
    }

    if (!isFinal) {
      return;
    }
    if (blankRunStart !== undefined) {
      // A trailing blank run is pending only because a lazy continuation could still follow;
      // on the last snapshot none can. It cannot be set inside a fence: opening one clears it.
      this.#commitBlock(cumulativeSource.slice(this.#remainderOffset, blankRunStart + 1));
      this.#remainderOffset = blankRunStart + 1;
    }
    this.#commitBlock(cumulativeSource.slice(this.#remainderOffset));
    this.#remainderOffset = cumulativeSource.length;
  }

  #commitBlock(block: string): void {
    if (block.trim() === "") {
      return;
    }
    this.#completeBlocks.push(block);
  }
}

/**
 * Blank separator lines ahead of the tail's first content line, and nothing more. Trimming all
 * leading whitespace would take that line's indentation, which is syntax: four spaces open an
 * indented code block. `[ \t]` rather than `\s`, which would match the newline itself.
 */
function withoutLeadingBlankLines(tail: string): string {
  return tail.replace(/^(?:[ \t]*\n)+/u, "");
}

/**
 * The container the block opening on this line is, if it is a list or indented code. Read from
 * the block's first content line only: re-reading from a later line would let a line inside a
 * list item claim to open an indented code block.
 */
function readBlockContainer(firstContentLine: string): BlockContainer | undefined {
  const listMarker = LIST_MARKER.exec(firstContentLine);
  if (listMarker !== null) {
    return readListContainer(listMarker);
  }
  if (leadingIndentColumns(firstContentLine) >= INDENTED_CODE_INDENT) {
    return { kind: "indented-code" };
  }
  return undefined;
}

/** The list container one marker match describes. */
function readListContainer(listMarker: RegExpExecArray): ListContainer {
  const markerIndent = (listMarker[1] ?? "").length;
  const bullet = listMarker[2];
  const orderedDigits = listMarker[3];
  const orderedDelimiter = listMarker[4] ?? "";
  const separator = listMarker[5] ?? "";
  const markerWidth = bullet === undefined ? (orderedDigits ?? "").length + 1 : 1;
  // Commonmark puts an item's content at the first non-space column after the marker, except
  // where that run is five or more columns: then the run opens indented code inside the item and
  // the content column is the marker plus one. A tab counts as one column, which under-states
  // the indent so the scan keeps a line it is unsure about rather than splitting a construct.
  const separatorWidth =
    separator.length >= 1 && separator.length <= INDENTED_CODE_INDENT && !separator.includes("\t")
      ? separator.length
      : 1;
  return {
    kind: "list",
    markerIndent,
    markerDelimiter: bullet ?? orderedDelimiter,
    continuationIndent: markerIndent + markerWidth + separatorWidth,
  };
}

/**
 * Whether the line after a blank run belongs to the container the block opened on; `false` for
 * a block that opened on nothing container-shaped (the ordinary paragraph boundary).
 */
function continuesContainer(container: BlockContainer | undefined, postBlankLine: string): boolean {
  if (container === undefined) {
    return false;
  }
  const indent = leadingIndentColumns(postBlankLine);
  if (container.kind === "indented-code") {
    return indent >= INDENTED_CODE_INDENT;
  }
  if (indent >= container.continuationIndent) {
    return true;
  }
  // A sibling item at the same indent and delimiter continues the list even where it does not
  // continue the item: that is a loose list.
  const siblingMarker = LIST_MARKER.exec(postBlankLine);
  if (siblingMarker === null) {
    return false;
  }
  const sibling = readListContainer(siblingMarker);
  return (
    sibling.markerIndent === container.markerIndent &&
    sibling.markerDelimiter === container.markerDelimiter
  );
}

/** A line's leading indent in columns, tabs counted to the next stop. */
function leadingIndentColumns(line: string): number {
  let columns = 0;
  for (const character of line) {
    if (character === " ") {
      columns += 1;
      continue;
    }
    if (character === "\t") {
      columns += TAB_STOP_COLUMNS - (columns % TAB_STOP_COLUMNS);
      continue;
    }
    break;
  }
  return columns;
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
