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

export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  InlineRefusal,
  RefusalBanner,
  RefusalCard,
} from "./Refusal.js";

// THE `@consumedBy` TAGS in this file are the dead-code gate's one exemption, on the
// terms `apps/desktop/AGENTS.md` sets: the view families (T-023p-1C-2 … 1C-7) reach
// these primitives through this door, and until a family lands its import nothing
// does. The tag rides the barrel specifier because that is the export knip reports;
// the family that first imports a symbol deletes its tag in the same commit.

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  ChipProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  ChipTone,
} from "./Chip.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  CHIP_TONES,
  Chip,
} from "./Chip.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  LedgerRowProps,
} from "./LedgerRow.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  LedgerRow,
} from "./LedgerRow.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  DerivedFigureProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  WireFigureProps,
} from "./Figure.js";
export { DerivedFigure, WireFigure } from "./Figure.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  ByteUnitLabel,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  FormattedByteQuantity,
} from "./wire-figures.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatByteQuantity,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatClockTime,
  formatCount,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatDuration,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatMoney,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatRate,
  formatRelativeTime,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatWireString,
} from "./wire-figures.js";
