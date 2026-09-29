// How one hunk's body flattens into rows, as a value computed once and read many times.
//
// Split out of `hunk-virtualization.ts` because it is a different job: that module
// owns WHICH row an absolute index addresses across a whole change set, and this one
// owns what a single hunk's body looks like under a view mode. The split is what
// makes the layout cacheable at all — the index builds one of these per hunk while it
// is already walking the hunks for its row count, and `rowAt` reads it rather than
// rebuilding it.
//
// WHY THE UNIFIED ARM HOLDS A COUNT AND NOT AN ARRAY. In unified mode the flattening
// is the identity — one row per line, in order — so materialising it costs one object
// per line to say `{lineIndex: n}` for every n. A five-thousand-line hunk is five
// thousand objects describing an arithmetic sequence, held for as long as the diff is
// open, and every scroll that touched that hunk used to rebuild them. The identity arm
// carries the length and answers a row by returning the index it was asked for, which
// is the same answer at no allocation.
//
// WHY THE SPLIT ARM STILL HOLDS ROWS. In split view a run of deletions immediately
// followed by a run of insertions pairs positionally, so the mapping from row to line
// is genuinely irregular and no arithmetic predicts it. That array is built once per
// hunk per index, which is what it costs; what it no longer costs is once per `rowAt`.
//
// THE PAIRING RULE HAS ONE HOME, AND IT IS THIS MODULE. Two readers want it and they
// want different answers: the split flattening wants ROWS, and the intraline
// segmentation wants one line's COUNTERPART. Both are the same rule — a run of
// deletions immediately followed by a run of insertions pairs positionally — so both
// walk runs with `runEndFrom` below rather than each carrying its own scan. A second
// copy would agree on every hunk until the first uneven run and then disagree about
// which line a highlight was computed against.

import type { DiffLine, DiffLineKind, DiffViewMode } from "./diff-model.js";

/** Which of a hunk body's lines one row addresses. The pairing, without the row. */
export interface HunkBodyRow {
  readonly lineIndex: number;
  readonly pairedLineIndex?: number;
}

/**
 * One hunk body's flattening, in whichever form describes it without waste.
 *
 * Two arms rather than one array because the two modes are two different shapes: one
 * is an arithmetic sequence and the other is a table. Collapsing them would mean
 * storing the sequence as a table, which is the allocation this type exists to avoid.
 */
export type HunkBodyLayout =
  | { readonly kind: "identity"; readonly rowCount: number }
  | { readonly kind: "paired"; readonly rows: readonly HunkBodyRow[] };

/**
 * Flatten one hunk's body under one view mode.
 *
 * ONE WALK ANSWERS BOTH QUESTIONS. The count a file's span is built from and the
 * addressing `rowAt` hands back come from this one value — a hunk whose deletions and
 * insertions are uneven flattens to a row count that no arithmetic over `lines.length`
 * predicts, so a second implementation for the count would agree with this one on
 * every hunk until the first uneven one, and then place every row below it at the
 * wrong offset.
 *
 * IN `unified` MODE THE FLATTENING IS THE IDENTITY — one row per line, in order, which
 * is what a unified patch is. In `split` mode the body is walked as maximal runs: a
 * run of deletions immediately followed by a run of insertions pairs positionally into
 * `max(deletions, insertions)` rows, each addressing up to one base line and up to one
 * head line, and the overhang of the longer run keeps its lines unpaired. A run with no
 * partner — an insertion block, a deletion block at the end of a hunk — is one row per
 * line, and so is every context line.
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
 * The body row at one offset within the hunk, or `undefined` past its end.
 *
 * The identity arm answers by arithmetic and the paired arm by lookup, which is the
 * whole point of the two arms: neither walks, and neither builds anything.
 */
export function hunkBodyRowAt(layout: HunkBodyLayout, offset: number): HunkBodyRow | undefined {
  if (layout.kind === "paired") {
    return layout.rows[offset];
  }
  return offset >= 0 && offset < layout.rowCount ? { lineIndex: offset } : undefined;
}

/**
 * The line one changed line is paired with, or `undefined` where it has no partner.
 *
 * THE SAME RULE THE SPLIT FLATTENING APPLIES, ASKED THE OTHER WAY ROUND. That walk
 * knows every pairing because it walks the whole body; this one is asked about a single
 * line, by a renderer that has materialised one row and wants that row's intraline
 * segmentation. So it finds the run the line sits in and counts from its start, which
 * is the same positional pairing and costs the run rather than the hunk.
 *
 * The pairing is a property of the HUNK BODY and not of a view mode: a modified line is
 * a delete run immediately followed by an insert run in both layouts, and unified view
 * draws the two rows separately without making them a different pair.
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
    // A context line is nobody's counterpart, and a gap's revealed lines are context by
    // construction — so there is no pairing to look for and no highlight to compute.
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
 * The first line of the run of `kind` that ENDS at `end`, inclusive.
 *
 * Zero-length where the line at `end` is not of that kind, which is how a caller asks
 * "is there a run of deletions immediately above this insertion" and gets `end + 1`
 * back when there is not.
 */
function runStartFrom(lines: readonly DiffLine[], end: number, kind: DiffLineKind): number {
  let cursor = end;
  while (cursor >= 0 && lines[cursor]?.kind === kind) {
    cursor -= 1;
  }
  return cursor + 1;
}
