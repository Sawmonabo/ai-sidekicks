// The ledger's structure door — chapters, seams, filters, find.
//
// What this subtree owns is everything the ledger knows ABOUT its own shape: which
// run a row belongs to, which rows an epoch superseded, what a filter admits, and what
// a query matched. None of it renders a row — the rows belong to the timeline subtree,
// absorbed through
// the timeline row seat — and none of it holds a store: every model here is a pure
// derivation over one loaded window, built by the frame's own `useMemo` and thrown
// away when the window changes.
//
// One component ships beside those models and is the one renderer of one of them: the
// find field. Everything else in this directory is a value a test can drive with no DOM
// at all, which is why the derivations and the surfaces live in different files.
//
// FOUR SEAMS, IN DIRECTORIES OF THEIR OWN. A pile of files on one floor is a pile with a
// door rather than a module, and the concerns in it change for four different reasons —
// `chapters/` (how the log folds), `child-runs/` (the runs a session spawned and the
// handoffs between actors), `narrowing/` (what a filter admits and what a query
// matched), and `seams/` (where a run begins, ends, or is retired). What stays at this
// root is what every one of them spends or publishes: this door, the sheet, the command
// table and the mount registry it acts on, and the row fixture their suites share.
//
// A SUB-MODULE PUBLISHES A DOOR ONLY WHERE ONE HAS READERS. `seams/` does, and so does
// `child-runs/`, whose two rows and disclosure hook the feed takes. The other two are
// read from outside only by THIS file, which must reach the DECLARING module or
// `console-no-barrel-chain` reports the second hop; a door whose only would-be reader
// cannot use it is a door with no consumer, which `barrel-census` and the dead-code gate
// both fail. Their siblings reach them by deep intra-family specifiers, which is what an
// intra-family import is for.
//
// WHY EVERY LINE BELOW IS NAMED. A door is what a name uses to LEAVE this directory,
// and until this file was named it forwarded seventeen modules with `export *`, so the
// census could not enumerate what it published and a reader could not tell the
// family's interface from what happened to be exported beside it. The list below is
// exactly what `ledger/pane/` and `ledger/cards/` import — the seam classifier's
// internals and the command table's fixtures stop here, reached deeply by their
// siblings inside this directory.
//
// A NAME REACHED ONLY BY A TEST IS NOT ON THIS LIST. Four were: the superseded-band
// derivation and the jump-absence tuple, each imported by one suite in another
// directory to assert totality over a closed set; the command owner beside its
// registrar, whose one production reader imports the declaring module directly and
// whose only reader THROUGH this door was the feed's scaffolding, invisible to the
// census while that scaffolding was misnamed as production; and the find walk's
// direction TUPLE, whose derived type the pane's find acts hold and whose values only
// the family's own closed-set suite reads. A door line for a test is a door widened for
// testing, so those four suites reach their module directly and the door publishes what
// production reaches.

// The sheets this directory owns, imported by its own door. Each belongs to a child
// that carries no door of its own, so this is their nearest owner; `seams/` and
// `child-runs/` each have a door and import their own. THERE IS NO PARENT SHEET
// BESIDE THEM: a parent sheet holds what the two share, and the one rule that ever
// qualified was a focus ring for two buttons no caller could reach, so it went when
// they did. A rule the two come to share again mints `structure.css` back, imported
// first for the cascade order `ledger/ledger.css` states.
import "./chapters/chapters.css";
import "./narrowing/narrowing.css";

export { ChapterHeader } from "./chapters/ChapterHeader.js";
export { FindInLedger } from "./narrowing/FindInLedger.js";
export { LedgerFilterBar } from "./narrowing/LedgerFilterBar.js";
export { ChapterCollapseState } from "./chapters/chapter-collapse.js";
export {
  LedgerChapterIndex,
  runIdOfChapteredRow,
  type LedgerChapter,
} from "./chapters/chapters.js";
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
export {
  ChildRunIndex,
  type ChildRunEntry,
  type HandoffEntry,
} from "./child-runs/child-run-entries.js";
export { LedgerSeamIndex, type LedgerSeam } from "./seams/seams.js";
export { SupersededIndex, type SupersededBand } from "./seams/superseded-bands.js";
