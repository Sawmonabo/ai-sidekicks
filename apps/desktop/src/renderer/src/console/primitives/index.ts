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
import "./choice-list.css";
import "./chord.css";
import "./nothing.css";
import "./refusal.css";
import "./ledger-row.css";
import "./partial-read.css";
import "./surface-absence.css";
import "./surface-failure.css";
import "./confirmation-dialog.css";

// The sheet's one filled-accent face, named where TypeScript can see it. Two
// surfaces outside this family wear it, so the name is declared once rather than
// spelled at each of them.
export { ACCENT_FILL_CLASS } from "./accent-fill.js";

export type { GlyphName } from "./Glyph.js";
export { Glyph } from "./Glyph.js";

export { ChordHint } from "./ChordHint.js";

// The console's ONE `ResizeObserver` construction site, through the door for the
// reason the announcer is: two view families arm a size source — the browser
// family's overlay registry and pane geometry publisher, and the terminal family's
// emulator — and they sit beside each other in the DAG, so a second construction
// site is the only other way either could have one.
export { observeElementResize } from "./element-resize.js";

// One boundary per surface, so a pane's render throw does not blank the window. It
// is in this family rather than in the frame's because its only input is `core`'s
// tripwire report, and because a view family wrapping its own rows cannot import the
// frame's door without closing a cycle.
export { SurfaceErrorBoundary } from "./ErrorBoundary.js";

// The chord vocabulary, and not only the printer. A surface that decides something
// ABOUT a chord — the browser family's page handback, which may claim a keystroke
// only when it holds a modifier — needs the same closed token set, the same
// resolution of `$mod`, and the same splitter the printer uses, because tinykeys'
// grammar makes `$mod++` a real chord that `chord.split("+")` reads wrongly. Every
// one of those was a second copy here before it was a door line.
export type { ChordModifierToken, ChordPlatform } from "./chord-format.js";
export {
  CHORD_MODIFIER_TOKENS,
  // The literal, not the binding. `PaletteOverlay.tsx` is the only module that hands
  // this to `parseChord`; every other reader PRINTS it, and one of those readers is
  // the primitive beside this door. Publishing it from `palette/` would have left a
  // primitive importing upward for a string.
  COMMAND_PALETTE_OPEN_CHORD,
  HOST_CHORD_PLATFORM,
  PLATFORM_MODIFIER_CHORD_TOKEN,
  PLATFORM_MODIFIER_TOKEN,
  decodeChordKeyToken,
  formatChordForPlatform,
  splitChordTokens,
} from "./chord-format.js";

// The surface-scale absence wrapper. In this family rather than in `frame/` because
// it is a presentational shell with no family of its own — a centred measure, a body
// slot, and one hint — and because both of its producers now sit BELOW the frame:
// `frame/RouteSurface.tsx` reaches down to it like any other consumer, and
// `seats/absorbed-surfaces.ts` could not have reached up at all.
export { SurfaceAbsence } from "./SurfaceAbsence.js";

// The console's ONE live announcer. Through this door rather than deep-imported,
// because the whole point of the primitive is that there is a single pair of
// regions per window: a family that reached past the barrel for its own would be
// the second speaker this module exists to prevent.
export { LiveAnnouncerProvider, useAnnounce } from "./LiveAnnouncerProvider.js";

// The announcer itself, because `LiveAnnouncerProvider`'s `announcer` prop is part of
// that component's public shape: a caller that supplies one — the frame does not, a
// surface's own tier does — has to be able to build one, and reaching past the barrel
// for the class while taking the provider through it would be one seam entered two ways.
export { LiveAnnouncer } from "./live-announcer.js";

// The one way a surface says its read landed. Through this door beside the announcer
// itself, because the two are one seam: a family that reached for `useAnnounce`
// directly to say a settlement would be re-writing the once-per-sentence rule, and
// the rule is the whole reason this hook exists rather than a bare call.
export { useSettlementAnnouncement } from "./settlement-announcement.js";

export { Nothing } from "./Nothing.js";

// The confirming dialog, and the tone its confirming act wears. Through the door
// because two view families were composing the same eight Base UI parts and neither
// could import the other's — siblings do not reach across — so a shared composition
// has nowhere to live but a layer below both. What the callers keep is their own copy
// and their own trigger class; the parts are here.
export type { ConfirmationTone } from "./ConfirmationDialog.js";
export { ConfirmationDialog } from "./ConfirmationDialog.js";

// The incomplete-reading vocabulary and its one notice. Through the door for the
// reason every family lane needs them: six families each wrote their own notice for
// this case and the sentences disagreed, so a family that reached past the barrel for
// a local copy would be one more of them.
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  PartialReadNotice,
  ReadingState,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  ReadingStateKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  RefusalScope,
} from "./partial-read.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  READING_STATE_KINDS,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  REFUSAL_SCOPES,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  behindProducerReading,
  partialReadNotices,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  readingNoticeFor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  uncheckedCoverageReading,
  unreadableDeliveryReading,
} from "./partial-read.js";
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  PartialReadProps,
} from "./PartialRead.js";
export { PartialRead } from "./PartialRead.js";

// The reading's sentence, said out loud. Through the door because it is the ONLY
// route a surface has to the announcer for this case: a family that wrote its own
// "announce once" latch would be the second latch, and one that made its own region
// would be the second speaker `LiveAnnouncerProvider` forbids.
//
// THE WORKFLOWS FAMILY IS NOT ON THIS CLAIM, and its absence is a finding rather than
// an omission. That family's two rendering sites are the one place a reader was
// expected and neither can be one: its scope picker announces nothing at all by
// design, and its browser's continuation refusal is already spoken through the
// family's own settlement adapter, so binding here would say that refusal twice.
// The two latches are also not the same latch — this one dedups on the SENTENCE SET,
// which is right for an incomplete-reading notice and wrong for a settlement, where
// two sessions holding the same number of rows say the same words and the second
// would go unspoken. A caller-supplied dedup key would make one primitive serve both
// and retire that adapter; it is not minted here, because a parameter with no caller
// is a policy question moved out of the primitive that currently answers it and into
// every call site. The family that would spend it owns that call.
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  useReadingAnnouncement,
} from "./reading-announcement.js";

// A window's own cap, which is a different fact from a read's completeness — see the
// module header for why the two vocabularies sit beside each other rather than one
// inside the other.
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  WindowAbsence,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  WindowAbsenceKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  WindowAbsenceNotice,
} from "./window-absence.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  WINDOW_ABSENCE_KINDS,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  windowAbsenceNotice,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  windowAbsenceNotices,
} from "./window-absence.js";
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  WindowAbsencesProps,
} from "./WindowAbsences.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  WindowAbsences,
} from "./WindowAbsences.js";

// No marker: `InlineRefusal` has its consumers — `seats/ConsolePaneChrome.tsx`, whose
// kind-narrowing adapter renders it where a pane body was mounted at another kind's
// address, and the composer, sidebar, runs, approvals, inspector, settings,
// collaboration, sessions, and agents surfaces, which render a row-scoped refusal
// through it — so a surviving tag would fail the run under
// `--treat-tag-hints-as-errors`.
export { InlineRefusal } from "./InlineRefusal.js";
export { RefusalBanner } from "./RefusalBanner.js";
export { RefusalCard } from "./RefusalCard.js";

// THE `@consumedBy` TAGS in this file are the dead-code gate's one exemption, on the
// terms `apps/desktop/AGENTS.md` sets: the view families (T-023p-1C-2 … 1C-7) reach
// these primitives through this door, and until a family lands its import nothing
// does. The tag rides the barrel specifier because that is the export knip reports;
// the family that first imports a symbol deletes its tag in the same commit.

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  ChipProps,
  ChipTone,
} from "./Chip.js";
export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  CHIP_TONES,
  Chip,
} from "./Chip.js";

// The windowed row and the keyboard that reaches it. Through the door because the
// two ARIA members are one claim every windowed list in the console makes the same
// way, and a family that wrote its own row is a family whose reader is told the list
// is as long as the window.
//
// THREE SYMBOLS, AND THAT IS THE WHOLE SEAM. `T-023p-1C-5` landed the two windowed
// lists this primitive exists for — `repos/diff-pane/DiffFileList.tsx` and
// `repos/restore/WindowedRestorePathList.tsx` — and both compose the row, the hook,
// and the one type a delegating row's renderer hands its child: the row's own props
// type is inferred from the element, the two ARIA marker names are written by the row
// rather than by its caller, and the index arithmetic is what the hook returns. The
// target-props type leaves through this door rather than being read back off the
// component, because a family deriving it again would hold a second closed set that
// agrees with this one only until the marker attribute is renamed on one side. The
// nine door lines that had carried `@consumedBy T-023p-1C-5` alongside these three
// named a consumer that has now shipped without importing any of them, so they were
// door lines with no production reader — the class
// `test/console/architecture/barrel-census.test.ts` owns and the dead-code gate cannot
// see, since the tag legitimately suppressed the finding. They are deleted rather than
// re-tagged; the co-located tests that do exercise those symbols read the module that
// declares them, which is what the census rule asks.
//
// AND THE SAME RULE WAS THEN APPLIED TO THE REST OF THAT TASK'S CLAIMS. The nine lines
// above went first; every other claim naming that task — on this door, on `core/`, and
// on `seats/` — was then re-checked the same way, against what the family's shipped
// modules actually import through the door rather than against who might want the
// symbol.
//
// NO COUNT IS SPELLED FOR THAT SWEEP, and the omission is the point. The number would
// describe a set spread over three trees that no merge preserves, so a reader here
// cannot re-derive it and a stale one reads as a fact — the failure the counts in this
// header were rewritten to stop. What stands in its place is the RULE the sweep ran,
// which any reader can re-run against the tree in front of them: a task claim is a
// claim about a READER, so it is checked against what that family's shipped modules
// import through the door, and it is deleted when they import none. It is not a census
// of the tree and never was — `seats/` has since landed reservations naming this task
// whose symbols this family does not import, and those stand exactly as the tag rule
// says they do, until the commit whose import deletes them.
export { WindowedListRow } from "./WindowedListRow.js";
export type { WindowedRowTargetProps } from "./WindowedListRow.js";
export { useWindowedRovingIndex } from "./windowed-row-index.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  LedgerRowProps,
} from "./LedgerRow.js";
export { LedgerRow } from "./LedgerRow.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  DerivedFigureProps,
} from "./DerivedFigure.js";
export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  WireFigureProps,
} from "./WireFigure.js";
// Rule 4's mono provenance signature. Through the door because the frame renders
// session ids with it, and a surface that reached for its own mono span would be
// the second rendering of the one claim this primitive exists to make.
// Neither name carries a marker any more: `WireFigure` is rendered by
// `frame/ContextPicker.tsx` and the `WireChoiceList` beside it, and `DerivedFigure`
// by the runs, approvals, and inspector panes, so a surviving tag would be the half
// of the marker an importing change owed and did not pay — which
// `--treat-tag-hints-as-errors` reports.
export { DerivedFigure } from "./DerivedFigure.js";
export { WireFigure } from "./WireFigure.js";

// The one row every surface that offers wire identifiers to choose between renders.
// A primitive rather than a frame component because its input is a list of wire
// strings and its only dependency is the figure above: the frame is not the lowest
// family that owns that, and a view family cannot import the frame's door at all.
export { WireChoiceList } from "./WireChoiceList.js";

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  ByteUnitLabel,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  FormattedByteQuantity,
} from "./wire-figures.js";
export {
  formatByteQuantity,
  formatClockTime,
  formatCount,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatPercent,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  formatRate,
  formatRelativeTime,
  formatWireDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4 */
  formatWireString,
} from "./wire-figures.js";
