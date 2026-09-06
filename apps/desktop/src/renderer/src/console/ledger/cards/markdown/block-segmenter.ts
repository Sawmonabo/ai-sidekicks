// The delta-fed block segmenter — where the committed prefix ends and the volatile
// tail begins.
//
// `Spec-023 §Console Libraries`, streaming-markdown row: "settled blocks parse once
// with a two-block settle lag", and that same row OWN-BUILDs "the delta-fed block
// segmenter". `markdown-rules.ts` rule 1 owns the other half of the split — the
// volatile tail is the reveal engine's and an incomplete construct never mounts. The
// measurement in `Spec-023 §References` D.2 is why: a whole-message re-parse costs 94.3 ms at 64 KB
// and is linear in length, so re-parsing per token is quadratic over a stream, while a
// 256 B–2 KB tail slice costs 0.30–1.31 ms.
//
// WHAT IT IS FED. The reveal engine publishes CUMULATIVE text for a lane — the whole of
// what may be shown, growing at one end. So the segmenter takes a snapshot rather than
// a delta and answers what changed, which is what lets one card be re-rendered from a
// store read without the segmenter having to have seen every intermediate frame.
//
// AND WHETHER THAT SNAPSHOT IS THE LAST. Everything this class holds back it holds back
// against a later character; a caller that knows there is none says so, and gets every
// block settled and an empty tail. Without that signal a finished body keeps its last
// two blocks and its whole remainder volatile forever, which costs a re-parse per
// remount and — the part that is not merely slow — routes complete text through
// `remend`, silently closing a construct its author left open on purpose.
//
// WHY A CLASS. It holds the split across frames and it is not a component's state: a
// re-render must not re-split from scratch, and a card that unmounts and remounts must
// not re-parse its whole history. The scan itself is incremental — the boundary search
// resumes from the last committed offset, so a growing message costs its growth rather
// than its length.
//
// THE SUBTLETY: A BLANK LINE IS NOT ALWAYS A BOUNDARY. Three commonmark containers hold
// blank lines inside themselves — a fenced code block, an indented code block, and a
// list item, whose blank line is what makes a list LOOSE rather than a list that ended.
// Getting any of them wrong splits one construct into two documents and parses each
// half with no memory of the other: half a code block rendered as prose, or a list
// item's second paragraph rendered as an unrelated top-level paragraph.
//
// So the scan carries interior state, and that is three rules rather than a parser —
// commonmark's block grammar has more openers than this, and a blockquote needs none of
// them because a `>`-prefixed blank line does not trim to empty. Each rule is decided
// from two lines: the one the block OPENED on, and the one following the blank run.

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

/** What a caller knows about the snapshot beyond its text. */
export interface MarkdownSegmentationOptions {
  /**
   * Whether this snapshot is the body's last. See this file's header for what it buys.
   */
  readonly isFinal: boolean;
}

/** A fence opener or closer, and the run length that has to be matched to close it. */
interface FenceState {
  readonly marker: string;
  readonly runLength: number;
}

/**
 * What the current block opened as, where that decides whether a blank line ends it.
 *
 * A closed set of exactly the two containers a fence's own state does not cover. A block
 * that opened as anything else — a paragraph, a heading, a quote, a table — takes the
 * plain rule, and `undefined` is that answer.
 */
type BlockContainer = { readonly kind: "indented-code" } | ListContainer;

/** The list arm of that set, named so the reader that builds one can be typed by it. */
interface ListContainer {
  readonly kind: "list";
  /** Columns of indent the marker itself sat at, so a sibling can be recognised. */
  readonly markerIndent: number;
  /**
   * The marker's own delimiter — a bullet character, or an ordered list's `.` / `)`.
   *
   * Commonmark starts a NEW list when this changes, so it is what separates a sibling
   * item from a different list that happens to begin here.
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
 * A bullet or ordered list marker, with the whitespace that separates it from content.
 *
 * The trailing `[ \t]+|$` is what keeps `-a` out: a marker needs whitespace after it, or
 * to be the whole line (an empty item). Ordered markers are capped at nine digits, which
 * is commonmark's own limit.
 */
const LIST_MARKER = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))([ \t]+|$)/u;

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
      // The lag is lifted rather than reduced: the scan has already committed the
      // remainder, so every block is final and the tail is empty by construction.
      return { settledBlocks: [...this.#completeBlocks], volatileTail: "" };
    }

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
   *
   * On a FINAL snapshot the walk ends by committing what it has: the trailing blank run
   * is a boundary rather than a maybe, and the unterminated last line is the author's
   * last line rather than a line still arriving.
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
      // On a final snapshot the last line is complete without one, and it is walked like
      // any other so that it can close — or continue — the container ahead of it.
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
          // The blank run behind this line closed the block before it. The block keeps
          // its own trailing blank line so a re-join reproduces the source exactly.
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
      // A trailing blank run is only ever pending because a lazy continuation could
      // still follow it. On the last snapshot none can, so it is the boundary it looks
      // like. (It cannot be set inside a fence: opening one clears it.)
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

/**
 * What container the block opening on this line is, if it is one of the two.
 *
 * Read from the block's FIRST content line and from nothing else: a container's identity
 * is fixed the moment it opens, and re-reading it from a later line would let a line
 * inside a list item claim to open an indented code block of its own.
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

/** The list container one marker match describes. Split out to keep the reader short. */
function readListContainer(listMarker: RegExpExecArray): ListContainer {
  const markerIndent = (listMarker[1] ?? "").length;
  const bullet = listMarker[2];
  const orderedDigits = listMarker[3];
  const orderedDelimiter = listMarker[4] ?? "";
  const separator = listMarker[5] ?? "";
  const markerWidth = bullet === undefined ? (orderedDigits ?? "").length + 1 : 1;
  // Commonmark puts an item's content at the first non-space column after the marker,
  // EXCEPT where that run is five or more columns — there the run itself opens indented
  // code inside the item and the content column is the marker plus one. A tab is treated
  // as that same one column rather than expanded, which is the conservative reading: it
  // under-states the continuation indent, so the scan keeps a line it is unsure about
  // rather than splitting a construct it should not have.
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
 * Whether the line after a blank run belongs to the container the block opened on.
 *
 * `false` for a block that opened on nothing container-shaped, which is the ordinary
 * paragraph-to-paragraph boundary and the answer this scan gave for every line before
 * containers were tracked at all.
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
  // A sibling item at the same indent under the same delimiter continues the LIST even
  // where it does not continue the item — which is exactly what a loose list is.
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
