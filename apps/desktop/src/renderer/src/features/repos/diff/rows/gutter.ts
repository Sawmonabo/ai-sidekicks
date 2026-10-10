// How wide a diff's line-number gutter is: as many figures as the widest number it shows, and
// never fewer than the gutter's minimum. One rule for Review's two columns and the flow's one.

import { DIFF_GUTTER_MIN_DIGITS } from "../measures.js";
import { type DiffFile } from "../model.js";

/** The figures a gutter whose widest number is `widestLineNumber` is wide. */
export function diffGutterDigitCount(widestLineNumber: number): number {
  return Math.max(DIFF_GUTTER_MIN_DIGITS, String(widestLineNumber).length);
}

/**
 * The figures each of Review's line-number columns is wide for one file: its largest line number
 * on either side, the hidden context a gap reveals included, so both columns and both halves of a
 * split row are sized alike and an expansion never widens them.
 */
export function diffFileGutterDigitCount(file: DiffFile): number {
  let widestLineNumber = 0;
  for (const hunk of file.hunks) {
    for (const line of [...hunk.precedingContext, ...hunk.lines]) {
      widestLineNumber = Math.max(
        widestLineNumber,
        line.baseLineNumber ?? 0,
        line.headLineNumber ?? 0,
      );
    }
  }
  return diffGutterDigitCount(widestLineNumber);
}
