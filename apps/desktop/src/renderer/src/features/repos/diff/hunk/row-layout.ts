// How one hunk's body flattens into rows, computed once per hunk by
// `features/repos/diff/rows/flat-index.ts` and read many times. The unified arm holds a count, not
// an array: the identity mapping would otherwise cost one object per line. The split arm holds
// rows, since positional pairing of delete and insert runs is irregular. The pairing rule lives
// here (`runEndFrom`) for both the row flattening and a single line's counterpart, so the two
// cannot disagree.

import type { DiffLine, DiffLineKind, DiffViewMode } from "../model.js";

/** Which of a hunk body's lines one row addresses. The pairing, without the row. */
export interface HunkBodyRow {
  readonly lineIndex: number;
  readonly pairedLineIndex?: number;
}

/**
 * One hunk body's flattening, in whichever form describes it without waste: unified is an
 * arithmetic sequence (a count) and split is an irregular table (rows).
 */
export type HunkBodyLayout =
  | { readonly kind: "identity"; readonly rowCount: number }
  | { readonly kind: "paired"; readonly rows: readonly HunkBodyRow[] };

/**
 * Flatten one hunk body under one view mode. The row count and the addressing both come from
 * this one value: uneven deletion and insertion runs make the count unpredictable from
 * `lines.length`, so a second count would misplace every row below the first uneven hunk.
 *
 * `unified` is the identity, one row per line. `split` walks maximal runs: deletions followed
 * immediately by insertions pair positionally into `max(deletions, insertions)` rows, the
 * longer run's overhang stays unpaired, and an unpartnered run or a context line is one row
 * per line.
 */
export function buildHunkBodyLayout(
  lines: readonly DiffLine[],
  viewMode: DiffViewMode,
): HunkBodyLayout {
  if (viewMode === "unified") {
    return { kind: "identity", rowCount: lines.length };
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
    cursor = runEndFrom(lines, cursor, "delete");
    const deleteCount = cursor - firstDeleteIndex;
    const firstInsertIndex = cursor;
    cursor = runEndFrom(lines, cursor, "insert");
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
  return { kind: "paired", rows };
}

/** How many rows one hunk's body occupies. */
export function hunkBodyRowCount(layout: HunkBodyLayout): number {
  return layout.kind === "identity" ? layout.rowCount : layout.rows.length;
}

/**
 * The body row at one offset, or `undefined` outside the hunk's body. The identity arm answers
 * by arithmetic and the paired arm by lookup; neither walks or builds anything.
 */
export function hunkBodyRowAt(layout: HunkBodyLayout, offset: number): HunkBodyRow | undefined {
  if (layout.kind === "paired") {
    return layout.rows[offset];
  }
  return offset >= 0 && offset < layout.rowCount ? { lineIndex: offset } : undefined;
}

/**
 * The line one changed line is paired with, or `undefined` where it has no partner. The
 * same positional rule the split flattening applies, asked about a single line: it finds the
 * run the line sits in and counts from its start, costing the run rather than the hunk. The
 * pairing belongs to the hunk body, not the view mode: unified view draws the two rows
 * separately without making them a different pair.
 */
export function pairedLineIndexFor(
  lines: readonly DiffLine[],
  lineIndex: number,
): number | undefined {
  const kind = lines[lineIndex]?.kind;
  if (kind === "delete") {
    const deleteRunStart = runStartFrom(lines, lineIndex, "delete");
    const insertRunStart = runEndFrom(lines, deleteRunStart, "delete");
    const insertLineIndex = insertRunStart + (lineIndex - deleteRunStart);
    return insertLineIndex < runEndFrom(lines, insertRunStart, "insert")
      ? insertLineIndex
      : undefined;
  }
  if (kind !== "insert") {
    // A context line is nobody's counterpart, and a gap's revealed lines are context.
    return undefined;
  }
  const insertRunStart = runStartFrom(lines, lineIndex, "insert");
  const deleteRunStart = runStartFrom(lines, insertRunStart - 1, "delete");
  const deleteCount = insertRunStart - deleteRunStart;
  const offset = lineIndex - insertRunStart;
  return offset < deleteCount ? deleteRunStart + offset : undefined;
}

/** The index one past the last line of the run of `kind` starting at `start`. */
function runEndFrom(lines: readonly DiffLine[], start: number, kind: DiffLineKind): number {
  let cursor = start;
  while (lines[cursor]?.kind === kind) {
    cursor += 1;
  }
  return cursor;
}

/**
 * The first line of the run of `kind` that ends at `end` (inclusive); `end + 1` when the line
 * at `end` is not of that kind.
 */
function runStartFrom(lines: readonly DiffLine[], end: number, kind: DiffLineKind): number {
  let cursor = end;
  while (cursor >= 0 && lines[cursor]?.kind === kind) {
    cursor -= 1;
  }
  return cursor + 1;
}
