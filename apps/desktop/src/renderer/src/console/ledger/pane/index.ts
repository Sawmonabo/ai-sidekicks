// The ledger's pane door — the body the deck mounts, and the chrome contract it asks for.
//
// WHY THIS DIRECTORY IS INSIDE THE FAMILY. The pane body is ledger view code: the
// feed, the window derivations, the find and replay acts, the row host. It lived under
// `panes/` while `panes/` was read as "where pane bodies go", and that directory is a
// COMPOSITION SITE — the layering gate subtracts it from both endpoints of the
// view-family rules so the one file whose job is to name every family can name them.
// Fifty-two modules of view code behind that subtraction meant the DAG rule the whole
// concurrent build rests on quantified over everything except the family's largest
// directory. `panes/` now holds its composition file and nothing else, and this body
// is where the rest of the family is, reached by the same intra-family specifiers its
// siblings use.
//
// WHAT LEAVES THROUGH THIS DOOR IS WHAT `ledger/index.ts` MOUNTS. The pane's own
// pieces — the feed and its rows, the window and jump models, the notices — are read
// by their siblings inside this directory, deeply, which is what an intra-family
// import is for. A door is the list of names that LEAVE.

export { TimelinePane, type LedgerPaneHeaderProps } from "./TimelinePane.js";
