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
// WHY EXPANSION IS A COUNT PER GAP AND NOT A BOOLEAN. This family requires hunk-gap
// expansion with predecessor retention: pressing expand a second time must not
// take back what the first press revealed. A boolean cannot express a partially
// expanded gap, so a second press would either do nothing or jump to the whole
// gap; a monotonically growing count expresses both states and makes retention a
// property of the type rather than of the handler that mutates it.
//
// THIS MODULE RENDERS NOTHING and imports no React. It is the arithmetic the
// renderer asks; every test of it runs without a DOM, which is what lets the
// endurance tier measure a five-thousand-line change set at all.

import { DIFF_GAP_EXPANSION_LINE_COUNT } from "./diff-bounds.js";
import type { ConsoleDiffModel, DiffLine, DiffViewMode } from "./diff-model.js";

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
 *
 * A SPLIT ROW MAY ADDRESS TWO LINES, which is what makes split view a comparison
 * rather than two stacked lists. A unified patch spells a modified line as a
 * deletion immediately followed by an insertion, so the pairing is a property of
 * the flattening: `lineIndex` names the deletion, which occupies the BASE side,
 * and `pairedLineIndex` names the insertion, which occupies the HEAD side. Every
 * other row names one line, and which side it occupies follows from that line's
 * own kind — a deletion is a base line, an insertion a head line, and a context
 * line is both.
 */
export interface DiffLineRow {
  readonly kind: "line";
  readonly fileIndex: number;
  readonly hunkIndex: number;
  readonly source: "preceding-context" | "hunk-body";
  readonly lineIndex: number;
  /**
   * The head line this row pairs with `lineIndex`'s base line, in the same
   * sequence `source` names. Present only on a `split` row that paired a
   * deletion with an insertion; absent everywhere else, including on every
   * `unified` row.
   */
  readonly pairedLineIndex?: number;
}

/** One addressable row of a rendered diff. Narrow on `kind`. */
export type DiffRow = DiffFileHeaderRow | DiffGapRow | DiffHunkHeaderRow | DiffLineRow;

/** Which of a hunk body's lines one row addresses. The pairing, without the row. */
interface HunkBodyRow {
  readonly lineIndex: number;
  readonly pairedLineIndex?: number;
}

/**
 * How one hunk's body flattens into rows, under one view mode.
 *
 * ONE WALK ANSWERS BOTH QUESTIONS. The count a file's span is built from and the
 * addressing `rowAt` hands back come from this one function — the count being the
 * length of what it returns — because a hunk whose deletions and insertions are
 * uneven flattens to a row count that no arithmetic over `lines.length` predicts.
 * A second implementation for the count would agree with this one on every hunk
 * until the first uneven one, and then place every row below it at the wrong
 * offset.
 *
 * IN `unified` MODE THE FLATTENING IS THE IDENTITY — one row per line, in order,
 * which is what a unified patch is. In `split` mode the body is walked as maximal
 * runs: a run of deletions immediately followed by a run of insertions pairs
 * positionally into `max(deletions, insertions)` rows, each addressing up to one
 * base line and up to one head line, and the overhang of the longer run keeps its
 * lines unpaired. A run with no partner — an insertion block, a deletion block at
 * the end of a hunk — is one row per line, and so is every context line.
 */
function hunkBodyRowLayout(
  lines: readonly DiffLine[],
  viewMode: DiffViewMode,
): readonly HunkBodyRow[] {
  if (viewMode === "unified") {
    return lines.map((_line, lineIndex) => ({ lineIndex }));
  }
  const rows: HunkBodyRow[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    if (lines[cursor]?.kind !== "delete") {
      rows.push({ lineIndex: cursor });
      cursor += 1;
      continue;
    }
    const firstDeleteIndex = cursor;
    while (lines[cursor]?.kind === "delete") {
      cursor += 1;
    }
    const deleteCount = cursor - firstDeleteIndex;
    const firstInsertIndex = cursor;
    while (lines[cursor]?.kind === "insert") {
      cursor += 1;
    }
    const insertCount = cursor - firstInsertIndex;
    for (let offset = 0; offset < Math.max(deleteCount, insertCount); offset += 1) {
      if (offset >= deleteCount) {
        rows.push({ lineIndex: firstInsertIndex + offset });
      } else if (offset >= insertCount) {
        rows.push({ lineIndex: firstDeleteIndex + offset });
      } else {
        rows.push({
          lineIndex: firstDeleteIndex + offset,
          pairedLineIndex: firstInsertIndex + offset,
        });
      }
    }
  }
  return rows;
}

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
  readonly #viewMode: DiffViewMode;
  readonly #fileSpans: readonly FileRowSpan[];
  readonly #rowCount: number;

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
    this.#viewMode = viewMode;

    const fileSpans: FileRowSpan[] = [];
    let rowCursor = 0;
    model.files.forEach((file, fileIndex) => {
      if (shownFilePath !== undefined && file.path !== shownFilePath) {
        return;
      }
      const startRowIndex = rowCursor;
      // The file's own header.
      let fileRowCount = 1;
      file.hunks.forEach((hunk, hunkIndex) => {
        const hidden = this.#hiddenLineCountFor(fileIndex, hunkIndex);
        // A gap row exists only while the gap still hides something.
        fileRowCount += hidden > 0 ? 1 : 0;
        fileRowCount += this.#revealedLineCountFor(fileIndex, hunkIndex);
        // The hunk header, then its body — whose row count is the walk's own
        // length rather than a second count that could disagree with it.
        fileRowCount += 1 + hunkBodyRowLayout(hunk.lines, viewMode).length;
      });
      fileSpans.push({ fileIndex, startRowIndex, rowCount: fileRowCount });
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
    const span = this.#spanAt(rowIndex);
    const file = span === undefined ? undefined : this.#model.files[span.fileIndex];
    if (span === undefined || file === undefined) {
      return undefined;
    }
    const fileIndex = span.fileIndex;
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
      const bodyRows = hunkBodyRowLayout(hunk.lines, this.#viewMode);
      const bodyRow = bodyRows[withinFile - cursor];
      if (bodyRow !== undefined) {
        return { kind: "line", fileIndex, hunkIndex, source: "hunk-body", ...bodyRow };
      }
      cursor += bodyRows.length;
    }
    return undefined;
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

  /** Binary search for the span that contains an absolute row index. */
  #spanAt(rowIndex: number): FileRowSpan | undefined {
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
    return this.#fileSpans[low];
  }
}
