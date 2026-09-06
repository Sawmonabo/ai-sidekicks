// The window seam: which of a session's rows this pane is holding at all.
//
// THE SEAM THIS DIRECTORY OWNS. Everything else under `pane/` decides what to DO with
// rows — narrow them, replay them, jump to one — and each of those decisions is taken
// over a set someone had to derive first. That derivation is one job with one hard
// rule: there are TWO windows, the loaded log and what the viewport is actually
// showing, and the whole directory exists so a caller cannot confuse them. The
// retention of row identities across passes lives here for the same reason, beside the
// derivation whose equality it is, and so does the component that says out loud which
// of the four ways this window is not the whole session applies.
//
// WHAT LEAVES. The two windows and their hooks, the chapter key the fold groups by,
// the retention a second derivation holds its own instance of, and the absences
// component. `deriveLedgerWindow` stops here: it is the pure derivation under
// `useLedgerProjection`, and every reader of it outside this directory is a suite or a
// suite's scaffolding, which reaches it deeply.

export { LedgerWindowAbsences } from "./LedgerWindowAbsences.js";
export {
  useRailGeometry,
  useVisibleLedgerWindow,
  type VisibleLedgerWindow,
} from "./ledger-visible-window.js";
export { LedgerRowRetention } from "./ledger-row-retention.js";
export {
  NO_ROWS_REMOVED,
  chapterKeyFor,
  useLedgerProjection,
  type LedgerPipelineStage,
  type LedgerWindowModel,
} from "./ledger-window.js";
