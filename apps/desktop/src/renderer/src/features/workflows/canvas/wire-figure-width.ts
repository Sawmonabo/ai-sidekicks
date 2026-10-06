// How wide a wire figure stands in a canvas's small text, worked out rather than measured: a
// figure is set in the mono face, whose every character has the one advance, so its width is its
// length times that advance. The face holds the Latin-1 characters alone; one outside it is set
// in a fallback face and counted a full em, the widest such a glyph is drawn. A node's kind label
// and count and an edge's count are all set so.

import {
  MONO_ADVANCE_EM,
  TYPE_SCALE_REM,
  WIRE_FIGURE_SIZE_EM,
} from "#renderer/styles/typography.js";
import { readCanvasUnits } from "./measures.js";

/** A wire figure's width in a canvas's small text, in canvas units. */
export function measureWireFigureWidth(figure: string): number {
  const figureSize = readCanvasUnits(TYPE_SCALE_REM, "text-xs") * WIRE_FIGURE_SIZE_EM;
  let advanceEm = 0;
  for (const character of figure) {
    const codePoint: number = character.codePointAt(0) ?? 0;
    advanceEm += codePoint <= LAST_MONO_CODE_POINT ? MONO_ADVANCE_EM : 1;
  }
  return advanceEm * figureSize;
}

/** The last code point the mono face's Latin-1 build holds. */
const LAST_MONO_CODE_POINT = 0xff;
