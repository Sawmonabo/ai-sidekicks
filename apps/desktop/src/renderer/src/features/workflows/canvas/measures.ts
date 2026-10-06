// A workflow canvas's own measures, in canvas units: the token scale read at the default text
// size. A node and an edge's count are part of the drawing, not chrome, so they scale with the
// zoom alone and a larger text size never pushes a node's lines past its box. Every canvas that
// draws workflow nodes sets them on its own element, and its sheet reads them from there.

import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { RADIUS_SCALE_REM, SPACE_SCALE_REM, scaleStep } from "#renderer/styles/palette.js";
import { BODY_LINE_HEIGHT, TYPE_SCALE_REM } from "#renderer/styles/typography.js";

/**
 * A node's ring, the stroke its state is drawn in, in canvas units. A stroke stays as drawn at
 * every size.
 */
export const NODE_RING_WIDTH = 2;

/**
 * A step of a rem scale, such as `text-xs` of `TYPE_SCALE_REM`, in canvas units: its CSS pixels at
 * the default text size. Throws on an unknown step.
 */
export function readCanvasUnits(scale: Readonly<Record<string, number>>, stepName: string): number {
  return scaleStep(scale, stepName) * DEFAULT_APPEARANCE_RECORD.textSize;
}

/** One line box of a type step, such as `text-xs`, at the body line height, in canvas units. */
export function readCanvasLineHeight(stepName: string): number {
  return readCanvasUnits(TYPE_SCALE_REM, stepName) * BODY_LINE_HEIGHT;
}

/**
 * The custom properties a canvas's sheet sets a node's content from, written on the canvas
 * element so every node and edge label inside it reads them.
 */
export const WORKFLOW_CANVAS_MEASURES: React.CSSProperties = {
  "--meridian-workflow-canvas-text-xs": canvasLength(TYPE_SCALE_REM, "text-xs"),
  "--meridian-workflow-canvas-text-sm": canvasLength(TYPE_SCALE_REM, "text-sm"),
  "--meridian-workflow-canvas-space-1": canvasLength(SPACE_SCALE_REM, "space-1"),
  "--meridian-workflow-canvas-space-2": canvasLength(SPACE_SCALE_REM, "space-2"),
  "--meridian-workflow-canvas-space-3": canvasLength(SPACE_SCALE_REM, "space-3"),
  "--meridian-workflow-canvas-radius-sm": canvasLength(RADIUS_SCALE_REM, "radius-sm"),
  "--meridian-workflow-canvas-ring": `${String(NODE_RING_WIDTH)}px`,
} as React.CSSProperties;

function canvasLength(scale: Readonly<Record<string, number>>, stepName: string): string {
  return `${String(readCanvasUnits(scale, stepName))}px`;
}
