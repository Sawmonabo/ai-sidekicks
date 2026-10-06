// How wide a wire figure stands in a canvas's small text, worked out rather than measured: a
// figure is set in the mono face, whose every character has the one advance, so its width is its
// length times that advance. A node's kind label and count and an edge's count are all set so.

import { formatCount } from "#renderer/lib/wire/figures.js";
import {
  MONO_ADVANCE_EM,
  TYPE_SCALE_REM,
  WIRE_FIGURE_SIZE_EM,
} from "#renderer/styles/typography.js";
import { readCanvasUnits } from "./measures.js";

/** A wire figure's width in a canvas's small text, in canvas units. */
export function measureWireFigureWidth(figure: string): number {
  const figureSize = readCanvasUnits(TYPE_SCALE_REM, "text-xs") * WIRE_FIGURE_SIZE_EM;
  return [...figure].length * MONO_ADVANCE_EM * figureSize;
}

/**
 * The widest of `figures`, the absent ones skipped, which a box or a gap keeps room for; one
 * digit when none is present yet.
 */
export function pickWidestFigure(figures: readonly (string | undefined)[]): string {
  let widest = formatCount(0);
  for (const figure of figures) {
    if (figure !== undefined && [...figure].length > [...widest].length) {
      widest = figure;
    }
  }
  return widest;
}
