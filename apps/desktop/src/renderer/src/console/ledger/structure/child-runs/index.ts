// The child-run seam: background work, and the moments work changes hands.
//
// WHAT THIS DIRECTORY OWNS. A ledger that draws only the run in front of it hides
// every child run the session spawned and every handoff between actors — which
// this ledger forbids in terms: it never hides background work. The derivation that
// finds those entries in a loaded window, the two rows that draw them, the anchor
// rule that keeps a subagent's card from walking down the log, and the expansion that
// asks the daemon for a child's own entries are one job, and it is the job the feed
// consults per row rather than repeating.
//
// WHAT LEAVES, AND WHY THROUGH A DOOR RATHER THAN THE FAMILY'S. The two rows and the
// disclosure hook are taken by `ledger/pane/feed/`, which is a sibling subtree, and
// this directory owns a sheet — so publishing the components here puts the sheet, its
// renderers, and the door that imports it in one place, exactly as `seams/index.ts`
// records for the seam row. The INDEXES leave through the family door from their own
// declaring modules, because `ledger/pane/window/` builds them beside the chapter,
// seam and superseded indexes and `console-no-barrel-chain` fails a door that reaches
// another door.

// The sheet this directory owns, imported by its own door.
import "./child-runs.css";

export { ChildRunSummaryRow } from "./ChildRunSummaryRow.js";
export { HandoffRow } from "./HandoffRow.js";

export { useChildRunDisclosure, type ChildRunDisclosure } from "./child-run-expansion.js";
