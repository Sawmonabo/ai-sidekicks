// What a diff's rows ARE, and how much of a gap has been revealed.
//
// SPLIT FROM `hunk-virtualization.ts` ON THE SEAM BETWEEN A VOCABULARY AND AN
// ARITHMETIC. That module answers which rows exist at which offsets under one
// expansion — a binary search over prefix sums, rebuilt per model and per mode. This
// one declares what a row is and what an expansion is, values every consumer of the
// index holds and none of them computes: `DiffRows.tsx` renders one of these, the pane
// holds an expansion in state and replaces it, and the index reads both. Two subjects,
// and the file that held them was doing two jobs, which `apps/desktop/AGENTS.md`
// rejects.
//
// WHY EXPANSION IS A COUNT PER GAP AND NOT A BOOLEAN. This family requires hunk-gap
// expansion with predecessor retention: pressing expand a second time must not take
// back what the first press revealed. A boolean cannot express a partially expanded
// gap, so a second press would either do nothing or jump to the whole gap; a
// monotonically growing count expresses both states and makes retention a property of
// the type rather than of the handler that mutates it.
//
// NOTHING HERE RENDERS and nothing here imports React.

import { DIFF_GAP_EXPANSION_LINE_COUNT } from "./diff-bounds.js";

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
