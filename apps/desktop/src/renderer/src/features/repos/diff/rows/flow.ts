// One file's rows as the conversation's flow draws them: its lines, a quiet separator wherever the
// file's lines are skipped between hunks, and no hunk header. The flow's gutter numbers each line
// once, by the new file, so its width is read off the same walk.

import {
  DIFF_FLOW_FILE_BLOCK_SCREENS,
  DIFF_FLOW_GUTTER_MIN_DIGITS,
  DIFF_FLOW_SHARE_DIVISOR,
  DIFF_ROW_HEIGHT_PX,
} from "../measures.js";
import { diffFileChangeNotes, type DiffFile, type DiffLine, type DiffModel } from "../model.js";
import { DiffRowIndex } from "./flat-index.js";
import type { DiffRow } from "./model.js";

/** One file's rows in the flow, and what its block's cut, footer and gutter are read from. */
export interface DiffFlowRows {
  /** The index the rows address, over a model holding this one file. */
  readonly index: DiffRowIndex;
  /** The rows drawn, in order: lines, separators, and the file's header only where it has a note. */
  readonly rows: readonly DiffRow[];
  /** How many of the rows are lines of the file. */
  readonly lineCount: number;
  /** Characters the gutter's widest number takes, never under the gutter's minimum. */
  readonly gutterDigitCount: number;
}

/**
 * The flow's rows of one file of `diff`. A hunk after the first opens with the separator that
 * stands for the lines skipped above it; the first hunk opens on its first line. The file's
 * header row is drawn only where the file carries a change note (a rename, a mode change, binary
 * or unreadable contents), so a file with no lines still says what changed.
 */
export function diffFlowRowsOf(diff: DiffModel, file: DiffFile): DiffFlowRows {
  const index = new DiffRowIndex({ baseRef: diff.baseRef, headRef: diff.headRef, files: [file] });
  const hasChangeNote = diffFileChangeNotes(file).length > 0;
  const rows: DiffRow[] = [];
  let lineCount = 0;
  let widestNumber = 0;
  for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
    const row = index.rowAt(rowIndex);
    if (row === undefined) {
      continue;
    }
    if (row.kind === "file-header") {
      if (hasChangeNote) {
        rows.push(row);
      }
    } else if (row.kind === "hunk-header") {
      // A gap row above the header already stands for the skipped lines.
      if (row.hunkIndex > 0 && rows.at(-1)?.kind !== "gap") {
        rows.push(row);
      }
    } else {
      rows.push(row);
      if (row.kind === "line") {
        lineCount += 1;
        widestNumber = Math.max(widestNumber, diffFlowLineNumber(index.lineFor(row)) ?? 0);
      }
    }
  }
  return {
    index,
    rows,
    lineCount,
    gutterDigitCount: Math.max(DIFF_FLOW_GUTTER_MIN_DIGITS, String(widestNumber).length),
  };
}

/** The number the flow's one gutter shows: the new file's, and a removed line's old one. */
export function diffFlowLineNumber(line: DiffLine): number | undefined {
  return line.kind === "delete" ? line.baseLineNumber : line.headLineNumber;
}

/**
 * How many rows a block draws before its cut: as many as a third of the visible flow holds, and
 * never none. Rows are at least a row tall, so no row past this count starts above the cut.
 */
export function diffFlowCutRowCount(flowHeightPx: number): number {
  return Math.max(1, Math.floor(flowHeightPx / DIFF_FLOW_SHARE_DIVISOR / DIFF_ROW_HEIGHT_PX));
}

/**
 * How many of a call's files draw a block: as many as two screens of the flow hold, each block
 * reckoned at its rows up to the cut plus `blockOverheadPx` (its footer and the space under it),
 * and always the first. A count of files, so it never changes how any one block is drawn.
 */
export function diffFlowDrawnFileCount(
  fileRows: readonly DiffFlowRows[],
  flowHeightPx: number,
  blockOverheadPx: number,
): number {
  const cutRowCount = diffFlowCutRowCount(flowHeightPx);
  const heldPx = flowHeightPx * DIFF_FLOW_FILE_BLOCK_SCREENS;
  let usedPx = 0;
  let drawnFileCount = 0;
  for (const flowRows of fileRows) {
    const blockPx =
      Math.min(flowRows.rows.length, cutRowCount) * DIFF_ROW_HEIGHT_PX + blockOverheadPx;
    if (drawnFileCount > 0 && usedPx + blockPx > heldPx) {
      break;
    }
    usedPx += blockPx;
    drawnFileCount += 1;
  }
  return drawnFileCount;
}
