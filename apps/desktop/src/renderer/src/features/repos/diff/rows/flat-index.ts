// Which rows of a diff exist, at which offsets. Files hold hunks and hunks hold lines, and a
// virtualizer needs a flat count, so the flattening is done here; the window itself is
// `@tanstack/react-virtual`'s and is not computed here, since it would assume every row is
// one row tall, which is false once a long line wraps. Nothing here renders or imports React.
//
// The flattening is an index, not an array: it stores per-file and per-hunk offsets and
// answers `rowAt` by binary search, so memory follows the change set's shape rather than its
// row count, and an expansion re-derives one prefix sum instead of thousands of row objects.

import type { DiffHunk, DiffModel, DiffLine, DiffViewMode } from "../model.js";
import { diffGapKey, type DiffGapExpansion, type DiffLineRow, type DiffRow } from "./model.js";
import {
  buildHunkBodyLayout,
  hunkBodyRowAt,
  hunkBodyRowCount,
  type HunkBodyLayout,
} from "../hunk/row-layout.js";

/**
 * The flattened row index of one diff, under one expansion state, narrowed to at most one of
 * its files. Immutable: an expansion produces a new index, which is what keeps a memoized
 * renderer correct.
 *
 * Narrowing is a view over the whole model, never a smaller model: filtering `model.files`
 * would renumber the files and every index the rows hand back (the expansion key, the gap
 * context lookup) would address the wrong file.
 */
export class DiffRowIndex {
  readonly #model: DiffModel;
  readonly #fileSpans: readonly FileRowSpan[];
  readonly #rowCount: number;
  #bodyLayoutBuildCount = 0;

  public constructor(
    model: DiffModel,
    expansion: DiffGapExpansion = new Map(),
    /** Show only the file at this wire-verbatim path. Absent shows every file. */
    shownFilePath?: string,
    /**
     * Which layout these rows are flattened for. It shapes the flattening itself, not only
     * the renderer: in split view a modified line is one row addressing two lines.
     */
    viewMode: DiffViewMode = "unified",
  ) {
    this.#model = model;
    // The mode is not held: it only shapes the flattening done here.

    const fileSpans: FileRowSpan[] = [];
    let rowCursor = 0;
    model.files.forEach((file, fileIndex) => {
      if (shownFilePath !== undefined && file.path !== shownFilePath) {
        return;
      }
      const startRowIndex = rowCursor;
      let fileRowCount = 1;
      const hunkSpans: HunkRowSpan[] = [];
      file.hunks.forEach((hunk, hunkIndex) => {
        const available = hunk.precedingContext.length;
        // Clamped so an expansion map wider than this gap cannot reveal lines it lacks.
        const revealed = Math.min(available, expansion.get(diffGapKey(fileIndex, hunkIndex)) ?? 0);
        const hidden = available - revealed;
        const bodyLayout = buildHunkBodyLayout(hunk.lines, viewMode);
        this.#bodyLayoutBuildCount += 1;
        // The gap row, the revealed context, the hunk header, then the body, whose row count
        // comes from the flattening itself.
        const hunkRowCount = (hidden > 0 ? 1 : 0) + revealed + 1 + hunkBodyRowCount(bodyLayout);
        hunkSpans.push({
          hunkIndex,
          startRowIndex: fileRowCount,
          hiddenLineCount: hidden,
          revealedLineCount: revealed,
          // Revealed context is the tail of `precedingContext`: a gap is read from the hunk
          // outwards.
          firstRevealedLineIndex: available - revealed,
          bodyLayout,
          rowCount: hunkRowCount,
        });
        fileRowCount += hunkRowCount;
      });
      fileSpans.push({ fileIndex, startRowIndex, rowCount: fileRowCount, hunkSpans });
      rowCursor += fileRowCount;
    });

    this.#fileSpans = fileSpans;
    this.#rowCount = rowCursor;
  }

  /** How many rows the whole diff renders under this expansion. */
  public get rowCount(): number {
    return this.#rowCount;
  }

  /** The diff these rows address. */
  public get model(): DiffModel {
    return this.#model;
  }

  /**
   * How many hunk body layouts this index has built. A correct index builds exactly one per
   * hunk it shows, in its constructor, and never another however many rows are read; a
   * `rowAt` that flattened as it walked would grow this on every scroll.
   */
  public get bodyLayoutBuildCount(): number {
    return this.#bodyLayoutBuildCount;
  }

  /**
   * The row at one absolute index, or `undefined` past the end. Two binary searches (file,
   * then hunk) and subtraction; it builds nothing and allocates only the returned row, so a
   * scroll costs the viewport rather than the change set.
   */
  public rowAt(rowIndex: number): DiffRow | undefined {
    if (rowIndex < 0 || rowIndex >= this.#rowCount) {
      return undefined;
    }
    const span = spanAt(this.#fileSpans, rowIndex);
    if (span === undefined) {
      return undefined;
    }
    const fileIndex = span.fileIndex;
    const withinFile = rowIndex - span.startRowIndex;
    if (withinFile === 0) {
      return { kind: "file-header", fileIndex };
    }
    const hunkSpan = spanAt(span.hunkSpans, withinFile);
    if (hunkSpan === undefined) {
      return undefined;
    }
    const hunkIndex = hunkSpan.hunkIndex;
    let withinHunk = withinFile - hunkSpan.startRowIndex;

    if (hunkSpan.hiddenLineCount > 0) {
      if (withinHunk === 0) {
        return { kind: "gap", fileIndex, hunkIndex, hiddenLineCount: hunkSpan.hiddenLineCount };
      }
      withinHunk -= 1;
    }
    if (withinHunk < hunkSpan.revealedLineCount) {
      return {
        kind: "line",
        fileIndex,
        hunkIndex,
        source: "preceding-context",
        lineIndex: hunkSpan.firstRevealedLineIndex + withinHunk,
      };
    }
    withinHunk -= hunkSpan.revealedLineCount;
    if (withinHunk === 0) {
      return { kind: "hunk-header", fileIndex, hunkIndex };
    }
    const bodyRow = hunkBodyRowAt(hunkSpan.bodyLayout, withinHunk - 1);
    return bodyRow === undefined
      ? undefined
      : { kind: "line", fileIndex, hunkIndex, source: "hunk-body", ...bodyRow };
  }

  /**
   * The line a `line` row addresses, or `undefined` for a row of another kind. A line row
   * always resolves: rows come from this index over this model.
   */
  public lineFor(row: DiffLineRow): DiffLine;
  public lineFor(row: DiffRow): DiffLine | undefined;
  public lineFor(row: DiffRow): DiffLine | undefined {
    return row.kind === "line" ? diffLineAt(this.#model, row, row.lineIndex) : undefined;
  }

  /**
   * The head line a paired split row addresses beside `lineFor`'s base line. The pairing is
   * carried on the row, so both sides resolve through the same addressing.
   */
  public pairedLineFor(row: DiffRow): DiffLine | undefined {
    if (row.kind !== "line" || row.pairedLineIndex === undefined) {
      return undefined;
    }
    return diffLineAt(this.#model, row, row.pairedLineIndex);
  }

  /**
   * The absolute row index a file's header sits at, or `undefined` where this index does not
   * show that file. A scan, because the spans cover only the shown files while the argument
   * names a file of the model.
   */
  public rowIndexOfFile(fileIndex: number): number | undefined {
    return this.#fileSpans.find((span) => span.fileIndex === fileIndex)?.startRowIndex;
  }
}

/**
 * The hunk a row addresses, in the model the row was flattened from. Throws on an address the
 * model does not hold: every row is built from that model, so a miss means the index and the
 * model disagree, which no rendering can make right.
 */
export function diffHunkAt(model: DiffModel, row: DiffLineRow): DiffHunk {
  const hunk = model.files[row.fileIndex]?.hunks[row.hunkIndex];
  if (hunk === undefined) {
    throw new Error(`No hunk ${String(row.hunkIndex)} in file ${String(row.fileIndex)}.`);
  }
  return hunk;
}

/** One line of the sequence a row's `source` names. Throws where `diffHunkAt` would. */
export function diffLineAt(model: DiffModel, row: DiffLineRow, lineIndex: number): DiffLine {
  const hunk = diffHunkAt(model, row);
  const line =
    row.source === "preceding-context" ? hunk.precedingContext[lineIndex] : hunk.lines[lineIndex];
  if (line === undefined) {
    throw new Error(`No line ${String(lineIndex)} in hunk ${String(row.hunkIndex)}.`);
  }
  return line;
}

/**
 * Where one file's rows start, and which file of the model they belong to. `fileIndex` is
 * carried because a narrowed index holds a span only for its shown file while every row it
 * hands out still addresses the model, and expansions are keyed by that index.
 */
interface FileRowSpan {
  readonly fileIndex: number;
  readonly startRowIndex: number;
  readonly rowCount: number;
  /** This file's hunks, each with the rows it occupies. Built once, in the constructor. */
  readonly hunkSpans: readonly HunkRowSpan[];
}

/**
 * Where one hunk's rows start within its file, and everything needed to address them. It
 * caches the constructor's own flattening walk, so `rowAt` never rebuilds a hunk's body
 * layout. Immutable like its index: a changed hunk set or mode produces a new index, so
 * there is nothing to invalidate.
 */
interface HunkRowSpan {
  readonly hunkIndex: number;
  /** Rows before this hunk's first, counted from the file's own header at zero. */
  readonly startRowIndex: number;
  /** Lines the gap above this hunk still hides. A gap row exists only above zero. */
  readonly hiddenLineCount: number;
  /** Lines of that gap revealed so far, drawn between the gap row and the header. */
  readonly revealedLineCount: number;
  /** Where the revealed run starts in `precedingContext` — a gap is read outwards. */
  readonly firstRevealedLineIndex: number;
  readonly bodyLayout: HunkBodyLayout;
  readonly rowCount: number;
}

/**
 * Binary search for the span, of either level, that contains a row index. Files and hunks
 * are both ordered, contiguous run lengths, so one search serves both.
 */
function spanAt<TSpan extends { readonly startRowIndex: number }>(
  spans: readonly TSpan[],
  rowIndex: number,
): TSpan | undefined {
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const span = spans[middle];
    if (span !== undefined && span.startRowIndex <= rowIndex) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return spans[low];
}
