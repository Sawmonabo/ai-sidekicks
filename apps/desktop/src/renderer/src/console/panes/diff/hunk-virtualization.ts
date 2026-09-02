// Which rows of a diff exist.
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
// WHY THE FLATTENING IS AN INDEX AND NOT AN ARRAY. A forty-file, five-thousand
// line change set is about five thousand rows; materialising them costs an object
// per row that is alive for as long as the diff is open, and every gap expansion
// rebuilds all of them. This class stores the per-file and per-hunk OFFSETS —
// tens of numbers — and answers `rowAt` by binary search, so the memory it holds
// is a function of the change set's shape rather than of its size, and an
// expansion re-derives one prefix-sum instead of five thousand objects.
//
// WHY EXPANSION IS A COUNT PER GAP AND NOT A BOOLEAN. §10.6 requires "hunk-gap
// expansion with predecessor retention": pressing expand a second time must not
// take back what the first press revealed. A boolean cannot express a partially
// expanded gap, so a second press would either do nothing or jump to the whole
// gap; a monotonically growing count expresses both states and makes retention a
// property of the type rather than of the handler that mutates it.
//
// THIS MODULE RENDERS NOTHING and imports no React. It is the arithmetic the
// renderer asks; every test of it runs without a DOM, which is what lets the
// endurance tier measure a five-thousand-line change set at all.

import { DIFF_GAP_EXPANSION_LINE_COUNT } from "./diff-bounds.js";
import type { ConsoleDiffModel, DiffLine } from "./diff-model.js";

// THE ROW KINDS ARE THE `DiffRow` UNION'S OWN DISCRIMINANT and are declared
// nowhere else. There are four, and `gap` is one of them rather than an
// affordance drawn between rows: a gap occupies height and takes focus, and a
// thing with height and focus that the row count does not know about is a row
// the window is placed wrong by.

/** A file's own header row. */
export interface DiffFileHeaderRow {
  readonly kind: "file-header";
  readonly fileIndex: number;
}

/** The collapsed context above a hunk, with what is still hidden. */
export interface DiffGapRow {
  readonly kind: "gap";
  readonly fileIndex: number;
  readonly hunkIndex: number;
  /** Lines this gap still hides. Never zero: a gap with nothing left is not drawn. */
  readonly hiddenLineCount: number;
}

/** A hunk's wire-verbatim `@@` header row. */
export interface DiffHunkHeaderRow {
  readonly kind: "hunk-header";
  readonly fileIndex: number;
  readonly hunkIndex: number;
}

/**
 * One line of content.
 *
 * `source` says which sequence `lineIndex` addresses — a revealed gap line comes
 * from the hunk's `precedingContext`, a body line from its `lines`. Two sequences
 * with one index space would need a sentinel or an offset convention, and both
 * are the kind of encoding that is read wrong once and then silently forever.
 */
export interface DiffLineRow {
  readonly kind: "line";
  readonly fileIndex: number;
  readonly hunkIndex: number;
  readonly source: "preceding-context" | "hunk-body";
  readonly lineIndex: number;
}

/** One addressable row of a rendered diff. Narrow on `kind`. */
export type DiffRow = DiffFileHeaderRow | DiffGapRow | DiffHunkHeaderRow | DiffLineRow;

/**
 * How much of each gap has been revealed, keyed by gap.
 *
 * A plain readonly map rather than a class, because it is a VALUE the renderer
 * holds in state and replaces: React re-renders on identity change, and a mutable
 * container would update in place and render nothing. `expandGap` below produces
 * the next value.
 */
export type DiffGapExpansion = ReadonlyMap<string, number>;

/** The key one gap is addressed by. One writer, so the two sides cannot drift. */
export function diffGapKey(fileIndex: number, hunkIndex: number): string {
  return `${String(fileIndex)}:${String(hunkIndex)}`;
}

/**
 * Reveal one more band of a gap's hidden context.
 *
 * Returns the NEXT expansion value; the argument is never mutated. Growth is
 * monotonic and clamped to what the gap holds, which is the predecessor-retention
 * rule expressed as arithmetic: `Math.max` of the previous count means no
 * activation can ever reveal less than the last one did.
 */
export function expandGap(
  expansion: DiffGapExpansion,
  fileIndex: number,
  hunkIndex: number,
  availableLineCount: number,
): DiffGapExpansion {
  const key = diffGapKey(fileIndex, hunkIndex);
  const revealed = expansion.get(key) ?? 0;
  const next = Math.min(
    availableLineCount,
    Math.max(revealed, revealed + DIFF_GAP_EXPANSION_LINE_COUNT),
  );
  if (next === revealed) {
    return expansion;
  }
  const grown = new Map(expansion);
  grown.set(key, next);
  return grown;
}

/** Where one file's rows start, and how many rows each of its hunks contributes. */
interface FileRowSpan {
  readonly startRowIndex: number;
  readonly rowCount: number;
  /** Row index, relative to the file's own start, at which each hunk begins. */
  readonly hunkStartRowIndices: readonly number[];
}

/**
 * The flattened row index of one diff, under one expansion state.
 *
 * Immutable: an expansion produces a NEW index, which is what makes a memoised
 * renderer correct — a mutated index would report new rows against an unchanged
 * identity and the rows on screen would not move.
 */
export class DiffRowIndex {
  readonly #model: ConsoleDiffModel;
  readonly #expansion: DiffGapExpansion;
  readonly #fileSpans: readonly FileRowSpan[];
  readonly #rowCount: number;

  public constructor(model: ConsoleDiffModel, expansion: DiffGapExpansion = new Map()) {
    this.#model = model;
    this.#expansion = expansion;

    const fileSpans: FileRowSpan[] = [];
    let rowCursor = 0;
    model.files.forEach((file, fileIndex) => {
      const startRowIndex = rowCursor;
      // The file's own header.
      let fileRowCount = 1;
      const hunkStartRowIndices: number[] = [];
      file.hunks.forEach((hunk, hunkIndex) => {
        hunkStartRowIndices.push(fileRowCount);
        const hidden = this.#hiddenLineCountFor(fileIndex, hunkIndex);
        // A gap row exists only while the gap still hides something.
        fileRowCount += hidden > 0 ? 1 : 0;
        fileRowCount += this.#revealedLineCountFor(fileIndex, hunkIndex);
        // The hunk header, then its body.
        fileRowCount += 1 + hunk.lines.length;
      });
      fileSpans.push({ startRowIndex, rowCount: fileRowCount, hunkStartRowIndices });
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
   * The row at one absolute index, or `undefined` past the end.
   *
   * Binary search over the per-file spans, then a walk of that file's hunks. The
   * search is what keeps `rowAt` sub-linear in the change set: a forty-file diff
   * costs about six comparisons rather than forty, and the per-file walk is
   * bounded by that file's hunk count rather than by its line count.
   */
  public rowAt(rowIndex: number): DiffRow | undefined {
    if (rowIndex < 0 || rowIndex >= this.#rowCount) {
      return undefined;
    }
    const fileIndex = this.#fileIndexAt(rowIndex);
    const span = this.#fileSpans[fileIndex];
    const file = this.#model.files[fileIndex];
    if (span === undefined || file === undefined) {
      return undefined;
    }
    const withinFile = rowIndex - span.startRowIndex;
    if (withinFile === 0) {
      return { kind: "file-header", fileIndex };
    }

    let cursor = 1;
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const hidden = this.#hiddenLineCountFor(fileIndex, hunkIndex);
      if (hidden > 0) {
        if (withinFile === cursor) {
          return { kind: "gap", fileIndex, hunkIndex, hiddenLineCount: hidden };
        }
        cursor += 1;
      }
      const revealed = this.#revealedLineCountFor(fileIndex, hunkIndex);
      if (withinFile < cursor + revealed) {
        // Revealed context is the TAIL of `precedingContext` — the lines nearest
        // the hunk — because a gap is read from the hunk outwards.
        const offsetFromFirstRevealed = withinFile - cursor;
        return {
          kind: "line",
          fileIndex,
          hunkIndex,
          source: "preceding-context",
          lineIndex: hunk.precedingContext.length - revealed + offsetFromFirstRevealed,
        };
      }
      cursor += revealed;
      if (withinFile === cursor) {
        return { kind: "hunk-header", fileIndex, hunkIndex };
      }
      cursor += 1;
      if (withinFile < cursor + hunk.lines.length) {
        return {
          kind: "line",
          fileIndex,
          hunkIndex,
          source: "hunk-body",
          lineIndex: withinFile - cursor,
        };
      }
      cursor += hunk.lines.length;
    }
    return undefined;
  }

  /** The line a `line` row addresses, or `undefined` if the row does not name one. */
  public lineFor(row: DiffRow): DiffLine | undefined {
    if (row.kind !== "line") {
      return undefined;
    }
    const hunk = this.#model.files[row.fileIndex]?.hunks[row.hunkIndex];
    if (hunk === undefined) {
      return undefined;
    }
    return row.source === "preceding-context"
      ? hunk.precedingContext[row.lineIndex]
      : hunk.lines[row.lineIndex];
  }

  /** The absolute row index a file's header sits at, or `undefined`. */
  public rowIndexOfFile(fileIndex: number): number | undefined {
    return this.#fileSpans[fileIndex]?.startRowIndex;
  }

  /** How many of a gap's lines are revealed under this expansion. */
  #revealedLineCountFor(fileIndex: number, hunkIndex: number): number {
    const available = this.#model.files[fileIndex]?.hunks[hunkIndex]?.precedingContext.length ?? 0;
    return Math.min(available, this.#expansion.get(diffGapKey(fileIndex, hunkIndex)) ?? 0);
  }

  /** How many of a gap's lines remain hidden under this expansion. */
  #hiddenLineCountFor(fileIndex: number, hunkIndex: number): number {
    const available = this.#model.files[fileIndex]?.hunks[hunkIndex]?.precedingContext.length ?? 0;
    return available - this.#revealedLineCountFor(fileIndex, hunkIndex);
  }

  /** Binary search for the file whose span contains an absolute row index. */
  #fileIndexAt(rowIndex: number): number {
    let low = 0;
    let high = this.#fileSpans.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      const span = this.#fileSpans[middle];
      if (span !== undefined && span.startRowIndex <= rowIndex) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }
}
