// The primitives door.
//
// Every console surface imports its primitives from here, and every sheet is
// imported exactly once — here — so a surface can never render a primitive that
// arrived without its CSS, and the bundler sees one edge per sheet rather than one
// per component.
//
// ONE SHEET PER PRIMITIVE, and the rule `apps/desktop/AGENTS.md` sets is about the
// door rather than about the count: "a family's CSS is imported from that family's
// barrel and from nowhere else". The single sheet these were split out of had
// reached 720 lines over a dozen unrelated primitives — two jobs by that file's own
// standard several times over — and a stylesheet nobody can hold in their head is
// where a second treatment for one thing gets added without anybody noticing. The
// order below is the cascade's: `shared.css` first because the focus ring and the
// hidden region qualify everything after it, then one sheet per primitive.
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

import "./shared.css";
import "./accent-fill.css";
import "./glyph.css";
import "./figure.css";
import "./chip.css";
import "./chord.css";
import "./nothing.css";
import "./refusal.css";
import "./ledger-row.css";
import "./partial-read.css";

export type { GlyphName } from "./Glyph.js";
export { Glyph } from "./Glyph.js";

export { ChordHint } from "./ChordHint.js";

export type { ChordPlatform } from "./chord-format.js";
export {
  HOST_CHORD_PLATFORM,
  decodeChordKeyToken,
  formatChordForPlatform,
} from "./chord-format.js";

// The console's ONE live announcer. Through this door rather than deep-imported,
// because the whole point of the primitive is that there is a single pair of
// regions per window: a family that reached past the barrel for its own would be
// the second speaker this module exists to prevent.
export { LiveAnnouncerProvider, useAnnounce } from "./LiveAnnouncerProvider.js";

export { Nothing } from "./Nothing.js";

// The incomplete-reading vocabulary and its one notice. Through the door for the
// reason every family lane needs them: six families each wrote their own notice for
// this case and the sentences disagreed, so a family that reached past the barrel for
// a local copy would be the seventh.
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  PartialReadNotice,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  ReadingState,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  ReadingStateKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  RefusalScope,
} from "./partial-read.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  READING_STATE_KINDS,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  REFUSAL_SCOPES,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  behindProducerReading,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  partialReadNotices,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  readingNoticeFor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  unreadableDeliveryReading,
} from "./partial-read.js";
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  PartialReadProps,
} from "./PartialRead.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  PartialRead,
} from "./PartialRead.js";

// The reading's sentence, said out loud. Through the door because it is the ONLY
// route a surface has to the announcer for this case: a family that wrote its own
// "announce once" latch would be the second latch, and one that made its own region
// would be the second speaker `LiveAnnouncerProvider` forbids.
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  useReadingAnnouncement,
} from "./reading-announcement.js";

// A window's own cap, which is a different fact from a read's completeness — see the
// module header for why the two vocabularies sit beside each other rather than one
// inside the other.
export type {
  /** @consumedBy T-023p-1C-3 */
  WindowAbsence,
  /** @consumedBy T-023p-1C-3 */
  WindowAbsenceKind,
  /** @consumedBy T-023p-1C-3 */
  WindowAbsenceNotice,
} from "./window-absence.js";
export {
  /** @consumedBy T-023p-1C-3 */
  WINDOW_ABSENCE_KINDS,
  /** @consumedBy T-023p-1C-3 */
  windowAbsenceNotice,
  /** @consumedBy T-023p-1C-3 */
  windowAbsenceNotices,
} from "./window-absence.js";
export type {
  /** @consumedBy T-023p-1C-3 */
  WindowAbsencesProps,
} from "./WindowAbsences.js";
export {
  /** @consumedBy T-023p-1C-3 */
  WindowAbsences,
} from "./WindowAbsences.js";

export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  InlineRefusal,
  RefusalBanner,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
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
  ChipTone,
} from "./Chip.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  CHIP_TONES,
  Chip,
} from "./Chip.js";

// The windowed row and the keyboard that reaches it. Through the door because the
// two ARIA members are one claim every windowed list in the console makes the same
// way, and a family that wrote its own row is a family whose reader is told the list
// is as long as the window.
export type {
  /** @consumedBy T-023p-1C-5 */
  WindowedListRowProps,
} from "./WindowedListRow.js";
export {
  /** @consumedBy T-023p-1C-5 */
  WindowedListRow,
} from "./WindowedListRow.js";
export type {
  /** @consumedBy T-023p-1C-5 */
  WindowedRovingIndex,
  /** @consumedBy T-023p-1C-5 */
  WindowedRovingIndexOptions,
  /** @consumedBy T-023p-1C-5 */
  WindowedRowMove,
} from "./windowed-row-index.js";
export {
  /** @consumedBy T-023p-1C-5 */
  WINDOWED_ROW_INDEX_ATTRIBUTE,
  /** @consumedBy T-023p-1C-5 */
  WINDOWED_ROW_MOVE_BY_KEY,
  /** @consumedBy T-023p-1C-5 */
  clampedRowIndex,
  /** @consumedBy T-023p-1C-5 */
  movedRowIndex,
  /** @consumedBy T-023p-1C-5 */
  useWindowedRovingIndex,
} from "./windowed-row-index.js";

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
// Rule 4's mono provenance signature. Through the door because the frame renders
// session ids with it, and a surface that reached for its own mono span would be
// the second rendering of the one claim this primitive exists to make.
export {
  DerivedFigure,
  // No marker: `WireFigure` has its consumers — `frame/ContextPicker.tsx` and
  // `frame/WireChoiceList.tsx` both render identifiers through it — so the tag that
  // stood here was the half of the marker its importing change owed and did not
  // pay. `--treat-tag-hints-as-errors` is what reported the debt.
  WireFigure,
} from "./Figure.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  ByteUnitLabel,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  FormattedByteQuantity,
} from "./wire-figures.js";
export {
  formatByteQuantity,
  formatClockTime,
  formatCount,
  formatDuration,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatMoney,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatRate,
  formatRelativeTime,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  formatWireString,
} from "./wire-figures.js";
