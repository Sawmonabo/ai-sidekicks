// The ledger's structure door — chapters, seams, the rail, replay, filters, find.
//
// What this subtree owns is everything the ledger knows ABOUT its own shape: which
// run a row belongs to, which rows an epoch superseded, where the marks on the
// minimap are, where a replay has got to, what a filter admits, and what a query
// matched. None of it renders a row — the rows are Plan-013's, absorbed through the
// timeline row seat — and none of it holds a store: every model here is a pure
// derivation over one loaded window, built by the frame's own `useMemo` and thrown
// away when the window changes.
//
// Three components ship beside those models, and each is the one renderer of one of
// them: the rail, the replay dock, and the find field. Everything else in this
// directory is a value a test can drive with no DOM at all, which is why the
// derivations and the painting live in different files.
//
// WHY EVERY LINE BELOW IS NAMED. A door is what a name uses to LEAVE this directory,
// and until this file was named it forwarded seventeen modules with `export *`, so the
// census could not enumerate what it published and a reader could not tell the
// family's interface from what happened to be exported beside it. The list below is
// exactly what `panes/timeline/` and `ledger/cards/` import — the painter, the seam
// classifier's internals, the rail's own geometry and the command table's fixtures
// stop here, reached deeply by their siblings inside this directory.
//
// A NAME REACHED ONLY BY A TEST IS NOT ON THIS LIST. Three were: the superseded-band
// derivation, the jump-absence tuple and the replay-state tuple, each imported by one
// suite in another directory to assert totality over a closed set. A door line for a
// test is a door widened for testing, so those three suites reach their module
// directly and the door publishes what production reaches.

export { ChapterHeader } from "./ChapterHeader.js";
export { FindInLedger } from "./FindInLedger.js";
export { LedgerFilterBar } from "./LedgerFilterBar.js";
export { ProvenanceRail } from "./ProvenanceRail.js";
export { ReplayControls } from "./ReplayControls.js";
export { SeamRow } from "./SeamRow.js";
export { ChapterCollapseState, LedgerChapterIndex, type LedgerChapter } from "./chapters.js";
export { CHAPTER_VISIBLE_ROW_CAP } from "./constants.js";
export {
  UNFILTERED_LEDGER,
  applyLedgerFilter,
  deriveLedgerFacets,
  isLedgerFiltered,
  jumpToEventId,
  scopeLedgerRowsToChannel,
  type LedgerFacets,
  type LedgerFilter,
  type LedgerJumpAbsence,
  type LedgerJumpOutcome,
  type LedgerJumpStages,
} from "./filters.js";
export {
  emptyFindResult,
  findInLedger,
  stepFindMatch,
  type LedgerFindResult,
} from "./find-model.js";
export { useMountedLedger, type LedgerStructureActs } from "./mounted-ledger.js";
export { ProvenanceRailModel, railViewportBand, type RailViewportBand } from "./rail-model.js";
export {
  ReplayEngine,
  type ReplayPosition,
  type ReplaySpeed,
  type ReplayState,
} from "./replay-model.js";
export { LedgerSeamIndex, type LedgerSeam } from "./seams.js";
export { LEDGER_COMMAND_OWNER, registerLedgerCommands } from "./structure-commands.js";
export { SupersededIndex } from "./superseded-bands.js";
