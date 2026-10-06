// What a diff's rows are, and how much of a gap has been revealed: the vocabulary that
// `flat-index.ts` computes over. `DiffRowView.tsx` renders a row and the pane holds an
// expansion in state. Expansion is a count per gap, not a boolean, so a second press keeps
// what the first revealed and retention is a property of the type.

import { DIFF_GAP_EXPANSION_LINE_COUNT } from "../measures.js";

// The row kinds are the `DiffRow` union's discriminant. `gap` is a row, not an affordance
// drawn between rows: it occupies height and takes focus, so the row count must know it.

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
 * One line of content. `source` says which sequence `lineIndex` addresses: a revealed gap
 * line comes from the hunk's `precedingContext`, a body line from its `lines`.
 *
 * A split row may address two lines. A unified patch spells a modified line as a deletion
 * followed by an insertion, so `lineIndex` names the deletion (base side) and
 * `pairedLineIndex` the insertion (head side). Every other row names one line, and its side
 * follows from that line's kind: a deletion is base, an insertion head, context both.
 */
export interface DiffLineRow {
  readonly kind: "line";
  readonly fileIndex: number;
  readonly hunkIndex: number;
  readonly source: "preceding-context" | "hunk-body";
  readonly lineIndex: number;
  /**
   * The head line this row pairs with `lineIndex`'s base line, in the sequence `source`
   * names. Present only on a `split` row that paired a deletion with an insertion.
   */
  readonly pairedLineIndex?: number;
}

/** One addressable row of a rendered diff. Narrow on `kind`. */
export type DiffRow = DiffFileHeaderRow | DiffGapRow | DiffHunkHeaderRow | DiffLineRow;

/**
 * How much of each gap has been revealed, keyed by gap. A plain readonly map because it is
 * a value the renderer holds in state and replaces: React re-renders on identity change.
 */
export type DiffGapExpansion = ReadonlyMap<string, number>;

/** The key one gap is addressed by. One writer, so the two sides cannot drift. */
export function diffGapKey(fileIndex: number, hunkIndex: number): string {
  return `${String(fileIndex)}:${String(hunkIndex)}`;
}

/**
 * Reveal one more band of a gap's hidden context. Returns the next expansion value and never
 * mutates its argument. Growth is monotonic and clamped to what the gap holds, so no
 * activation reveals less than the last one did.
 */
export function expandGap(
  expansion: DiffGapExpansion,
  fileIndex: number,
  hunkIndex: number,
  availableLineCount: number,
): DiffGapExpansion {
  const key = diffGapKey(fileIndex, hunkIndex);
  const revealed = expansion.get(key) ?? 0;
  const next = Math.min(availableLineCount, revealed + DIFF_GAP_EXPANSION_LINE_COUNT);
  if (next === revealed) {
    return expansion;
  }
  const grown = new Map(expansion);
  grown.set(key, next);
  return grown;
}
