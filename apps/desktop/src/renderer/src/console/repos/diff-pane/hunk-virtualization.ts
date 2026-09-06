// Which rows of a diff exist, at which offsets.
//
// A diff is not a list of items, it is a nested structure — files hold hunks,
// hunks hold lines, and gaps between hunks hold lines a reader has not asked for
// yet — and every virtualizer's contract starts from a flat count. So the
// flattening IS the work, and it is the part a library cannot do. What is left
// after it — which of those rows a scroll position needs, at what offset, under
// what total height — is `@tanstack/react-virtual`'s, which
// `Spec-023 §Console Libraries` ADOPTs and `DiffRenderer.tsx` is the seam for.
// This module answers the count and the addressing and computes no window: the
// one it used to compute assumed every row was exactly one row tall, which is
// false the moment the wrap toggle is on.
//
// WHAT A ROW IS, and how much of a gap has been revealed, are `diff-row-model.ts`'s:
// values the renderer and the pane hold, which this module reads and does not declare.
//
// WHY THE FLATTENING IS AN INDEX AND NOT AN ARRAY. A forty-file, five-thousand
// line change set is about five thousand rows; materialising them costs an object
// per row that is alive for as long as the diff is open, and every gap expansion
// rebuilds all of them. This class stores the per-file and per-hunk OFFSETS —
// tens of numbers — and answers `rowAt` by binary search, so the memory it holds
// is a function of the change set's shape rather than of its size, and an
// expansion re-derives one prefix-sum instead of five thousand objects.
//
// THIS MODULE RENDERS NOTHING and imports no React. It is the arithmetic the
// renderer asks; every test of it runs without a DOM, which is what lets the
// endurance tier measure a five-thousand-line change set at all.

import type { ConsoleDiffModel, DiffLine, DiffViewMode } from "./diff-model.js";
import {
  diffGapKey,
  type DiffGapExpansion,
  type DiffLineRow,
  type DiffRow,
} from "./diff-row-model.js";
import {
  buildHunkBodyLayout,
  hunkBodyRowAt,
  hunkBodyRowCount,
  type HunkBodyLayout,
} from "./hunk-row-layout.js";

/**
 * Where one file's rows start, and which file of the MODEL they belong to.
 *
 * `fileIndex` is carried rather than implied by the span's own position, because
 * a narrowed index holds a span only for the file it shows while every row it
 * hands out still addresses the model. A file's index is what a gap expansion is
 * keyed by and what the pane resolves a hunk's available context from, so an
 * index that renumbered its files under a filter would key one file's expansion
 * against another file's context.
 */
interface FileRowSpan {
  readonly fileIndex: number;
  readonly startRowIndex: number;
  readonly rowCount: number;
  /** This file's hunks, each with the rows it occupies. Built once, in the constructor. */
  readonly hunkSpans: readonly HunkRowSpan[];
}

/**
 * Where one hunk's rows start within its file, and everything needed to address them.
 *
 * THE CACHE THE FINDING ASKED FOR, AND IT IS A CACHE OF THE CONSTRUCTOR'S OWN WALK
 * rather than a second structure beside it. The index already had to flatten every
 * hunk to know its row count; holding what that flattening produced costs nothing
 * extra and is what lets `rowAt` answer without rebuilding it. `rowAt` used to rebuild
 * a hunk's whole body layout for every hunk it walked past — so one five-thousand-line
 * hunk allocated five thousand row objects per rendered virtual row, and again on
 * every scroll render, which is virtualization paying the cost virtualization exists
 * to avoid.
 *
 * IMMUTABLE, AND SO IS ITS INVALIDATION. A `DiffRowIndex` is built per (model,
 * expansion, view mode) and never mutated, so a changed hunk set or a changed mode
 * produces a NEW index with new spans; there is no staleness question to answer and
 * no invalidation hook to forget to call.
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
 * The flattened row index of one diff, under one expansion state, narrowed to at
 * most one of its files.
 *
 * Immutable: an expansion produces a NEW index, which is what makes a memoised
 * renderer correct — a mutated index would report new rows against an unchanged
 * identity and the rows on screen would not move.
 *
 * NARROWING IS A VIEW OVER THE WHOLE MODEL AND NEVER A SMALLER MODEL. `DiffPane.tsx`
 * opens on its file list and narrows the rows to the file a person picks;
 * doing that by filtering `model.files` renumbers them, and every index the rows
 * then hand back — to the expansion key, and to the host resolving how much
 * context a gap still holds — addresses the wrong file. So the file stays where
 * it is and the flattening skips the others.
 */
export class DiffRowIndex {
  readonly #model: ConsoleDiffModel;
  readonly #expansion: DiffGapExpansion;
  readonly #fileSpans: readonly FileRowSpan[];
  readonly #rowCount: number;
  #bodyLayoutBuildCount = 0;

  public constructor(
    model: ConsoleDiffModel,
    expansion: DiffGapExpansion = new Map(),
    /** Show only the file at this wire-verbatim path. Absent shows every file. */
    shownFilePath?: string,
    /**
     * Which layout these rows are flattened for.
     *
     * The view mode is an input to the FLATTENING and not only to the row
     * renderer, because in split view a modified line is one row addressing two
     * lines rather than two rows addressing one each. A renderer that paired at
     * paint time would be pairing rows the count above it had already spaced
     * apart.
     */
    viewMode: DiffViewMode = "unified",
  ) {
    this.#model = model;
    this.#expansion = expansion;
    // The mode is not held: it is an input to the FLATTENING, which happens here, and
    // a field nothing reads afterwards would suggest a lookup still consults it.

    const fileSpans: FileRowSpan[] = [];
    let rowCursor = 0;
    model.files.forEach((file, fileIndex) => {
      if (shownFilePath !== undefined && file.path !== shownFilePath) {
        return;
      }
      const startRowIndex = rowCursor;
      // The file's own header.
      let fileRowCount = 1;
      const hunkSpans: HunkRowSpan[] = [];
      file.hunks.forEach((hunk, hunkIndex) => {
        const available = hunk.precedingContext.length;
        const revealed = Math.min(available, expansion.get(diffGapKey(fileIndex, hunkIndex)) ?? 0);
        // A gap row exists only while the gap still hides something.
        const hidden = available - revealed;
        const bodyLayout = buildHunkBodyLayout(hunk.lines, viewMode);
        this.#bodyLayoutBuildCount += 1;
        // The gap row, the revealed context, the hunk header, then the body — whose
        // row count is the flattening's own rather than a second count that could
        // disagree with it.
        const hunkRowCount = (hidden > 0 ? 1 : 0) + revealed + 1 + hunkBodyRowCount(bodyLayout);
        hunkSpans.push({
          hunkIndex,
          startRowIndex: fileRowCount,
          hiddenLineCount: hidden,
          revealedLineCount: revealed,
          // Revealed context is the TAIL of `precedingContext` — the lines nearest
          // the hunk — because a gap is read from the hunk outwards.
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
  public get model(): ConsoleDiffModel {
    return this.#model;
  }

  /** The expansion state these rows were flattened under. */
  public get expansion(): DiffGapExpansion {
    return this.#expansion;
  }

  /**
   * How many hunk body layouts this index has built.
   *
   * The caching assertion, not an inference — `RefreshScheduler.performCount`'s rule.
   * A correct index builds exactly one per hunk it shows, in its constructor, and
   * never another however many rows are read from it; a `rowAt` that flattened as it
   * walked would grow this on every scroll, which is a defect no row-level assertion
   * can see because the rows it hands back are identical either way.
   */
  public get bodyLayoutBuildCount(): number {
    return this.#bodyLayoutBuildCount;
  }

  /**
   * The row at one absolute index, or `undefined` past the end.
   *
   * TWO BINARY SEARCHES AND THEN ARITHMETIC. The outer one finds the file, the inner
   * one the hunk within it, and what is left is subtraction against the counts that
   * hunk's span already holds. It reads nothing out of the model, builds nothing, and
   * allocates only the row it returns — which is what makes a scroll cost the viewport
   * rather than the change set. The walk this replaced re-flattened every hunk it
   * passed, so reading one row near the end of a large hunk cost that hunk's whole
   * body, once per rendered row and again on every scroll render.
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

  /** The line a `line` row addresses, or `undefined` if the row does not name one. */
  public lineFor(row: DiffRow): DiffLine | undefined {
    return row.kind === "line" ? this.#lineAt(row, row.lineIndex) : undefined;
  }

  /**
   * The head line a paired split row addresses beside `lineFor`'s base line.
   *
   * A sibling reader rather than a second index: the pairing is carried on the
   * row, so both sides resolve through the same addressing and there is no second
   * structure that could describe a different diff.
   */
  public pairedLineFor(row: DiffRow): DiffLine | undefined {
    if (row.kind !== "line" || row.pairedLineIndex === undefined) {
      return undefined;
    }
    return this.#lineAt(row, row.pairedLineIndex);
  }

  /** One line of the sequence a row's `source` names. */
  #lineAt(row: DiffLineRow, lineIndex: number): DiffLine | undefined {
    const hunk = this.#model.files[row.fileIndex]?.hunks[row.hunkIndex];
    if (hunk === undefined) {
      return undefined;
    }
    return row.source === "preceding-context"
      ? hunk.precedingContext[lineIndex]
      : hunk.lines[lineIndex];
  }

  /**
   * The absolute row index a file's header sits at, or `undefined` where this
   * index does not show that file.
   *
   * A scan over the spans rather than a lookup by position: the spans are the
   * files this index SHOWS and the argument names a file of the model, and the
   * two are the same list only when nothing is narrowed.
   */
  public rowIndexOfFile(fileIndex: number): number | undefined {
    return this.#fileSpans.find((span) => span.fileIndex === fileIndex)?.startRowIndex;
  }
}

/**
 * Binary search for the span, of either level, that contains a row index.
 *
 * ONE SEARCH FOR BOTH LEVELS, because the two are the same question asked of two
 * ordered, contiguous, non-overlapping run lengths: which file a row of the diff falls
 * in, and which hunk a row of a file falls in. A second copy for the inner level would
 * be the same arithmetic written twice, and the off-by-one that makes the last span
 * unreachable is exactly the kind that would be fixed in one copy and not the other.
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
