// How one hunk's body flattens into rows, computed once per hunk by
// `features/repos/diff/rows/flat-index.ts` and read many times. The unified arm holds a count, not
// an array: the identity mapping would otherwise cost one object per line. The split arm holds
// rows, since positional pairing of delete and insert runs is irregular. The pairing rule lives
// here (`walkHunkRuns`) for both the row flattening and each line's partner, so the two cannot
// disagree.

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
  walkHunkRuns(lines, {
    onLoneLine: (lineIndex) => {
      rows.push({ lineIndex });
    },
    onReplacedRun: (run) => {
      for (let offset = 0; offset < Math.max(run.deleteCount, run.insertCount); offset += 1) {
        if (offset >= run.deleteCount) {
          rows.push({ lineIndex: run.firstInsertIndex + offset });
        } else if (offset >= run.insertCount) {
          rows.push({ lineIndex: run.firstDeleteIndex + offset });
        } else {
          rows.push({
            lineIndex: run.firstDeleteIndex + offset,
            pairedLineIndex: run.firstInsertIndex + offset,
          });
        }
      }
    },
  });
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
 * Each line's partner in one hunk body, by index: the line it is paired with, or `-1` where it
 * has none. One walk over the hunk, by the positional rule the split flattening applies. The
 * pairing belongs to the hunk body, not the view mode: unified view draws the two rows
 * separately without making them a different pair.
 */
export function hunkLinePartners(lines: readonly DiffLine[]): Int32Array {
  const partners = new Int32Array(lines.length).fill(-1);
  walkHunkRuns(lines, {
    onLoneLine: () => undefined,
    onReplacedRun: (run) => {
      for (let offset = 0; offset < Math.min(run.deleteCount, run.insertCount); offset += 1) {
        partners[run.firstDeleteIndex + offset] = run.firstInsertIndex + offset;
        partners[run.firstInsertIndex + offset] = run.firstDeleteIndex + offset;
      }
    },
  });
  return partners;
}

/** A run of deletions and the run of insertions right after it, which may be empty. */
interface ReplacedRun {
  readonly firstDeleteIndex: number;
  readonly deleteCount: number;
  readonly firstInsertIndex: number;
  readonly insertCount: number;
}

/**
 * Walk a hunk body once, in order: each deletion run with the insertion run that follows it, and
 * every other line on its own. The one home of the pairing rule.
 */
function walkHunkRuns(
  lines: readonly DiffLine[],
  visit: {
    readonly onLoneLine: (lineIndex: number) => void;
    readonly onReplacedRun: (run: ReplacedRun) => void;
  },
): void {
  let cursor = 0;
  while (cursor < lines.length) {
    if (lines[cursor]?.kind !== "delete") {
      visit.onLoneLine(cursor);
      cursor += 1;
      continue;
    }
    const firstDeleteIndex = cursor;
    cursor = runEndFrom(lines, cursor, "delete");
    const firstInsertIndex = cursor;
    cursor = runEndFrom(lines, cursor, "insert");
    visit.onReplacedRun({
      firstDeleteIndex,
      deleteCount: firstInsertIndex - firstDeleteIndex,
      firstInsertIndex,
      insertCount: cursor - firstInsertIndex,
    });
  }
}

/** The index one past the last line of the run of `kind` starting at `start`. */
function runEndFrom(lines: readonly DiffLine[], start: number, kind: DiffLineKind): number {
  let cursor = start;
  while (lines[cursor]?.kind === kind) {
    cursor += 1;
  }
  return cursor;
}
