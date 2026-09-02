// The primitives door.
//
// Every console surface imports its primitives from here, and the stylesheet is
// imported exactly once — here — so a surface can never render a primitive that
// arrived without its CSS, and the bundler sees one edge into the sheet rather than
// one per component.
//
// `wire-figures.js` is re-exported through the same door on purpose: the formatting
// rule (`Spec-023 §Console Design (Meridian)` §The eight rules) is that a figure is
// either wire-verbatim or `Intl`-formatted from the exact wire value, and that
// module is the only implementation of either. A surface that reaches for its own
// `toFixed` is a surface that did not know the door was there.
//
// `chord-format.js` is here for the same reason and one more: it is the vocabulary
// `ChordHint` renders, so a caller that wants the STRING form of a chord and a
// caller that wants keycaps are reading one table. It lives in this family rather
// than in `palette/` so a primitive never imports upward.

import "./primitives.css";

export type { GlyphName } from "./Glyph.js";
export { Glyph } from "./Glyph.js";

export { ChordHint } from "./ChordHint.js";

export type { ChordPlatform } from "./chord-format.js";
export {
  HOST_CHORD_PLATFORM,
  decodeChordKeyToken,
  formatChordForPlatform,
} from "./chord-format.js";

export { Nothing } from "./Nothing.js";

export { RefusalBanner } from "./Refusal.js";

export { DerivedFigure, WireFigure } from "./Figure.js";

export { formatCount } from "./wire-figures.js";
