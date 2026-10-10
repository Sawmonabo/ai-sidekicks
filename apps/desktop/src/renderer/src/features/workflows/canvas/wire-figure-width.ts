// How wide a wire figure stands in a canvas's small text, worked out rather than measured: a
// figure is set in the mono face, whose every character has the one advance, so its width is its
// length times that advance. A character none of the face's splits holds is set in a fallback
// face and counted a full em, the widest such a glyph is drawn. A node's count and an edge's
// count are set so, and a node's kind words are measured the same way.

import {
  MONO_ADVANCE_EM,
  TYPE_SCALE_REM,
  WIRE_FIGURE_SIZE_EM,
} from "#renderer/styles/typography.js";
import { isDrawnInPlexMono } from "#renderer/styles/typeface.js";
import { readCanvasUnits } from "./measures.js";

/** A wire figure's width in a canvas's small text, in canvas units. */
export function measureWireFigureWidth(figure: string): number {
  const figureSize = readCanvasUnits(TYPE_SCALE_REM, "text-xs") * WIRE_FIGURE_SIZE_EM;
  let advanceEm = 0;
  for (const character of figure) {
    const codePoint: number = character.codePointAt(0) ?? 0;
    advanceEm += isDrawnInPlexMono(codePoint) ? MONO_ADVANCE_EM : 1;
  }
  return advanceEm * figureSize;
}
