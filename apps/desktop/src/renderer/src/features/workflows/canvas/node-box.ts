// The size of a node's box on a workflow canvas, derived from what the box holds, in canvas units
// at the default text size, so a layout pass can place every node before anything is drawn.
//
// Across, a box holds its kind's row: the kind's label and the item count, each a wire figure in
// the mono face, whose width is its length times the face's one advance. A node's own name
// shares that room and gives way where it is longer. Down, it holds its name row, its kind row
// and its state row, or its handles where they need more, and one line more for a failure or
// the instant a wait resumes. A handle's slot is one line of the small text a handle's label is
// set in.

import { SPACE_SCALE_REM } from "#renderer/styles/palette.js";
import {
  BODY_LINE_HEIGHT,
  MONO_ADVANCE_EM,
  TYPE_SCALE_REM,
  WIRE_FIGURE_SIZE_EM,
} from "#renderer/styles/typography.js";
import { NODE_RING_WIDTH, readCanvasUnits } from "./measures.js";

/** What one node's box must hold. */
export interface NodeBoxContent {
  /** The kind's label as the box draws it, a wire figure on its kind row. */
  readonly kindLabel: string;
  /** The widest item count figure the box keeps room for beside its name. */
  readonly countFigure: string;
  /** How many handles stand down the node's busier side. */
  readonly handleCount: number;
  /** Whether the box carries one line more: a failure, or the instant a wait resumes. */
  readonly hasExtraLine: boolean;
}

/** A node box's size, in canvas units. */
export interface NodeBoxSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How much a box grows to carry one more line and the gap above it, in canvas units. A canvas
 * keeps more than this between two nodes in a column, so a box that grows never reaches the next.
 */
export const NODE_EXTRA_LINE_HEIGHT: number =
  readCanvasUnits(SPACE_SCALE_REM, "space-1") + lineHeight("text-xs");

/** The box that holds `content`, with the same size for every node of one kind and count. */
export function deriveNodeBoxSize(content: NodeBoxContent): NodeBoxSize {
  const ring = 2 * NODE_RING_WIDTH;
  const kindRow =
    wireFigureWidth(content.kindLabel) +
    readCanvasUnits(SPACE_SCALE_REM, "space-2") +
    wireFigureWidth(content.countFigure);
  const width = ring + 2 * readCanvasUnits(SPACE_SCALE_REM, "space-3") + kindRow;
  const rows =
    lineHeight("text-sm") +
    2 * lineHeight("text-xs") +
    2 * readCanvasUnits(SPACE_SCALE_REM, "space-1");
  const contentHeight = ring + 2 * readCanvasUnits(SPACE_SCALE_REM, "space-2") + rows;
  // Handles stand evenly spaced down a side, one slot apart and one slot from each end.
  const handleHeight = ring + (content.handleCount + 1) * lineHeight("text-xs");
  const height = Math.max(contentHeight, handleHeight);
  return { width, height: content.hasExtraLine ? height + NODE_EXTRA_LINE_HEIGHT : height };
}

/** One line box of a type step, in canvas units. */
function lineHeight(stepName: string): number {
  return readCanvasUnits(TYPE_SCALE_REM, stepName) * BODY_LINE_HEIGHT;
}

/** A wire figure set in a box's small text: its characters times the mono face's advance. */
function wireFigureWidth(figure: string): number {
  const figureSize = readCanvasUnits(TYPE_SCALE_REM, "text-xs") * WIRE_FIGURE_SIZE_EM;
  return [...figure].length * MONO_ADVANCE_EM * figureSize;
}
