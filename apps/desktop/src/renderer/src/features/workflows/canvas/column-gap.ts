// The gap between two columns of a workflow canvas, derived from what an edge across it must
// show: its item count's label, in a box with its padding, and on each side of that box one line
// of the small text's height of bare edge, so the edge reads as a connection past its label and
// the label never stands on either node. The labels are wire figures, so their widths are worked
// out, not measured, and the gap is known before the layout pass places anything.

import { SPACE_SCALE_REM } from "#renderer/styles/palette.js";
import { readCanvasLineHeight, readCanvasUnits } from "./measures.js";
import { measureWireFigureWidth } from "./wire-figure-width.js";

/**
 * The padding an edge's count label keeps around its figure, across and then down, in canvas
 * units; the graph library's own order for a label's background padding.
 */
export const EDGE_LABEL_PADDING: readonly [number, number] = [
  readCanvasUnits(SPACE_SCALE_REM, "space-1"),
  readCanvasUnits(SPACE_SCALE_REM, "space-1"),
];

/** The column gap, in canvas units, that holds `widestLabel`: the widest count any edge draws. */
export function deriveColumnGap(widestLabel: string): number {
  const labelBox = measureWireFigureWidth(widestLabel) + 2 * EDGE_LABEL_PADDING[0];
  return labelBox + 2 * readCanvasLineHeight("text-xs");
}
