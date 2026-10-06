// The type, spacing and corner a run graph node's content is set at, in canvas units: the token
// scale read at the default text size. A node is part of the drawing, not chrome, so its content
// scales with the zoom alone, as its stated box does, and a larger text size never pushes it out.

import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { RADIUS_SCALE_REM, SPACE_SCALE_REM, scaleStep } from "#renderer/styles/palette.js";
import { TYPE_SCALE_REM } from "#renderer/styles/typography.js";

/** A rem step as canvas units: its CSS pixels at the default text size. */
function canvasLength(scale: Readonly<Record<string, number>>, stepName: string): string {
  return `${String(scaleStep(scale, stepName) * DEFAULT_APPEARANCE_RECORD.textSize)}px`;
}

/**
 * The custom properties the graph sheet sets a node's content from, written on the canvas so
 * every node and edge label inside it reads them.
 */
export const RUN_GRAPH_CANVAS_MEASURES: React.CSSProperties = {
  "--meridian-run-graph-text-xs": canvasLength(TYPE_SCALE_REM, "text-xs"),
  "--meridian-run-graph-text-sm": canvasLength(TYPE_SCALE_REM, "text-sm"),
  "--meridian-run-graph-space-1": canvasLength(SPACE_SCALE_REM, "space-1"),
  "--meridian-run-graph-space-2": canvasLength(SPACE_SCALE_REM, "space-2"),
  "--meridian-run-graph-space-3": canvasLength(SPACE_SCALE_REM, "space-3"),
  "--meridian-run-graph-radius-sm": canvasLength(RADIUS_SCALE_REM, "radius-sm"),
} as React.CSSProperties;
