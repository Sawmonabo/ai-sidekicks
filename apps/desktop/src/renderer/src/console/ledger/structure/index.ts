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
// FIVE SEAMS, IN DIRECTORIES OF THEIR OWN. Forty-odd files on one floor is a pile with a
// door rather than a module, and the concerns in it change for five different reasons —
// `chapters/` (how the log folds), `narrowing/` (what a filter admits and what a query
// matched), `rail/` (the minimap: its ticks, its bands, its painter and its surface),
// `replay/` (where a walk has got to), and `seams/` (where a run begins, ends, or is
// retired). What stays at this root is what every one of them spends or publishes: this
// door, the bounds, the sheet, the command table and the mount registry it acts on, and
// the row fixture their suites share.
//
// A SUB-MODULE PUBLISHES A DOOR ONLY WHERE ONE HAS READERS. `seams/` does — the rail and
// the replay engine both hold its index. The other four are read from outside only by
// THIS file, which must reach the DECLARING module or `console-no-barrel-chain` reports
// the second hop; a door whose only would-be reader cannot use it is a door with no
// consumer, which `barrel-census` and the dead-code gate both fail. Their siblings reach
// them by deep intra-family specifiers, which is what an intra-family import is for.
//
// WHY EVERY LINE BELOW IS NAMED. A door is what a name uses to LEAVE this directory,
// and until this file was named it forwarded seventeen modules with `export *`, so the
// census could not enumerate what it published and a reader could not tell the
// family's interface from what happened to be exported beside it. The list below is
// exactly what `ledger/pane/` and `ledger/cards/` import — the painter, the seam
// classifier's internals, the rail's own geometry and the command table's fixtures
// stop here, reached deeply by their siblings inside this directory.
//
// A NAME REACHED ONLY BY A TEST IS NOT ON THIS LIST. Five were: the superseded-band
// derivation, the jump-absence tuple and the replay-state tuple, each imported by one
// suite in another directory to assert totality over a closed set; the command owner
// beside its registrar, whose one production reader imports the declaring module
// directly and whose only reader THROUGH this door was the feed's scaffolding,
// invisible to the census while that scaffolding was misnamed as production; and the
// find walk's direction TUPLE, whose derived type the pane's find acts hold and whose
// values only the family's own closed-set suite reads. A door line for a test is a
// door widened for testing, so those five suites reach their module directly and the
// door publishes what production reaches.

// The sheets this directory owns, imported by its own door. The four below the root
// belong to children that carry no door of their own, so this is their nearest
// owner; `seams/` has a door and imports its own. Parent before children, which is
// the cascade order `ledger/ledger.css` states.
import "./structure.css";
import "./chapters/chapters.css";
import "./narrowing/narrowing.css";
import "./rail/rail.css";
import "./replay/replay.css";

export { ChapterHeader } from "./chapters/ChapterHeader.js";
export { FindInLedger } from "./narrowing/FindInLedger.js";
export { LedgerFilterBar } from "./narrowing/LedgerFilterBar.js";
export { ProvenanceRail } from "./rail/ProvenanceRail.js";
export { ReplayControls } from "./replay/ReplayControls.js";
export { SeamRow } from "./seams/SeamRow.js";
export { ChapterCollapseState } from "./chapters/chapter-collapse.js";
export {
  LedgerChapterIndex,
  runIdOfChapteredRow,
  type LedgerChapter,
} from "./chapters/chapters.js";
export { CHAPTER_VISIBLE_ROW_CAP } from "./structure-bounds.js";
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
} from "./narrowing/filters.js";
export {
  emptyFindResult,
  findInLedger,
  stepFindMatch,
  type FindStepDirection,
  type LedgerFindResult,
} from "./narrowing/find-model.js";
export { useMountedLedger, type LedgerStructureActs } from "./mounted-ledger.js";
export { railViewportBand, type RailViewportBand } from "./rail/rail-bands.js";
export { ProvenanceRailModel } from "./rail/rail-model.js";
export {
  ReplayEngine,
  type ReplayPosition,
  type ReplaySpeed,
  type ReplayState,
} from "./replay/replay-model.js";
export { LedgerSeamIndex, type LedgerSeam } from "./seams/seams.js";
export { SupersededIndex } from "./seams/superseded-bands.js";
