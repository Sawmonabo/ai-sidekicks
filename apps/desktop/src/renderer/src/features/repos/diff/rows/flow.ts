// One file's rows as the conversation's flow draws them: its lines, a quiet separator wherever the
// file's lines are skipped between hunks, and no file or hunk header; a file with no lines keeps
// its header alone. The flow's gutter numbers each line once, by the new file, so its width is read
// off the same walk.

import { DIFF_FLOW_FILE_BLOCK_SCREENS, DIFF_FLOW_SHARE_DIVISOR } from "../measures.js";
import {
  diffFileChangeNotes,
  diffFileUnshownReason,
  type DiffFile,
  type DiffLine,
  type DiffModel,
} from "../model.js";
import { DiffRowIndex } from "./flat-index.js";
import { diffGutterDigitCount } from "./gutter.js";
import type { DiffRow } from "./model.js";

/** One file's rows in the flow, and what its block's cut, footer and gutter are read from. */
export interface DiffFlowRows {
  /** The index the rows address, over a model holding this one file. */
  readonly index: DiffRowIndex;
  /** The rows drawn, in order: lines and separators, or the header of a file with no lines. */
  readonly rows: readonly DiffRow[];
  /** How many of the rows are lines of the file. */
  readonly lineCount: number;
  /** Characters the gutter's widest number takes, never under the gutter's minimum. */
  readonly gutterDigitCount: number;
  /**
   * What changed about a file with no lines to draw, in Review's words, written where its lines
   * would be; empty for a file with lines.
   */
  readonly bodyNotes: readonly string[];
  /** Whether the block has a footer: a count of its lines, or a patch to copy. */
  readonly hasFooter: boolean;
}

/** What a block takes beyond its rows, in CSS pixels: its footer, and the space under it. */
export interface DiffBlockOverhead {
  readonly footerPx: number;
  readonly gapPx: number;
}

/**
 * The flow's rows of each file of one diff, each built the first time its block is reckoned or
 * drawn, so the files folded past two screens build none.
 */
export class DiffFlowRowsByFile {
  readonly #diff: DiffModel;
  readonly #rowsByFile: (DiffFlowRows | undefined)[] = [];

  public constructor(diff: DiffModel) {
    this.#diff = diff;
  }

  /** How many files the diff holds. */
  public get fileCount(): number {
    return this.#diff.files.length;
  }

  /** The rows of the file at `fileIndex`. Throws for a file the diff does not hold. */
  public rowsOf(fileIndex: number): DiffFlowRows {
    const built = this.#rowsByFile[fileIndex];
    if (built !== undefined) {
      return built;
    }
    const file = this.#diff.files[fileIndex];
    if (file === undefined) {
      throw new Error(`No file ${String(fileIndex)} in the diff.`);
    }
    const rows = diffFlowRowsOf(this.#diff, file);
    this.#rowsByFile[fileIndex] = rows;
    return rows;
  }
}

/** The number the flow's one gutter shows: the new file's, and a removed line's old one. */
export function diffFlowLineNumber(line: DiffLine): number | undefined {
  return line.kind === "delete" ? line.baseLineNumber : line.headLineNumber;
}

/**
 * How many rows a block draws before its cut: as many rows of `rowHeightPx` as a third of the
 * visible flow holds, and never none. Rows are at least a row tall, so no row past this count
 * starts above the cut.
 */
export function diffFlowCutRowCount(flowHeightPx: number, rowHeightPx: number): number {
  return Math.max(1, Math.floor(flowHeightPx / DIFF_FLOW_SHARE_DIVISOR / rowHeightPx));
}

/**
 * How many of a call's files draw a block: as many as two screens of the flow hold, each block
 * reckoned at its rows of `rowHeightPx` up to the cut, a row for its notes where it has no lines,
 * its footer where it has one and the space under it, and always the first. A count of files, so
 * it never changes how any one block is drawn; it builds the rows of the files it reckons only.
 */
export function diffFlowDrawnFileCount(
  rowsByFile: DiffFlowRowsByFile,
  flowHeightPx: number,
  overhead: DiffBlockOverhead,
  rowHeightPx: number,
): number {
  const cutRowCount = diffFlowCutRowCount(flowHeightPx, rowHeightPx);
  const heldPx = flowHeightPx * DIFF_FLOW_FILE_BLOCK_SCREENS;
  let usedPx = 0;
  let drawnFileCount = 0;
  for (let fileIndex = 0; fileIndex < rowsByFile.fileCount; fileIndex += 1) {
    const flowRows = rowsByFile.rowsOf(fileIndex);
    const blockRowCount =
      Math.min(flowRows.rows.length, cutRowCount) + (flowRows.bodyNotes.length > 0 ? 1 : 0);
    const blockPx =
      blockRowCount * rowHeightPx + (flowRows.hasFooter ? overhead.footerPx : 0) + overhead.gapPx;
    if (drawnFileCount > 0 && usedPx + blockPx > heldPx) {
      break;
    }
    usedPx += blockPx;
    drawnFileCount += 1;
  }
  return drawnFileCount;
}

/** The attribute each step of a block's rows carries, holding the step's index in the block. */
export const DIFF_FLOW_STEP_ATTRIBUTE = "data-diff-flow-step";

/**
 * The flow's rows of one file of `diff`. A hunk after the first opens with the separator that
 * stands for the lines skipped above it; the first hunk opens on its first line. Only a file with
 * no lines draws its header, with what changed about it written where its lines would be.
 */
function diffFlowRowsOf(diff: DiffModel, file: DiffFile): DiffFlowRows {
  const index = new DiffRowIndex({ baseRef: diff.baseRef, headRef: diff.headRef, files: [file] });
  const hasHeader = file.hunks.length === 0;
  const rows: DiffRow[] = [];
  let lineCount = 0;
  let widestNumber = 0;
  for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
    const row = index.rowAt(rowIndex);
    if (row === undefined) {
      continue;
    }
    if (row.kind === "file-header") {
      if (hasHeader) {
        rows.push(row);
      }
    } else if (row.kind === "unshown-reason") {
      // The flow writes the reason with the file's other notes, where its lines would be.
      continue;
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
  const unshownReason = diffFileUnshownReason(file);
  return {
    index,
    rows,
    lineCount,
    gutterDigitCount: diffGutterDigitCount(widestNumber),
    bodyNotes: hasHeader
      ? [
          ...diffFileChangeNotes(file, "header"),
          ...(unshownReason === undefined ? [] : [unshownReason]),
        ]
      : [],
    hasFooter: lineCount > 0 || file.patch !== undefined,
  };
}
