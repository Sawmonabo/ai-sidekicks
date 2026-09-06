// The ledger's pane door — the body the deck mounts.
//
// WHY THIS DIRECTORY IS INSIDE THE FAMILY. The pane body is ledger view code: the
// feed, the window derivations, the find and replay acts, the row host. It lived under
// `panes/` while `panes/` was read as "where pane bodies go", and that directory is a
// COMPOSITION SITE — the layering gate subtracts it from both endpoints of the
// view-family rules so the one file whose job is to name every family can name them.
// The whole of this body sat behind that subtraction — every module the four
// sub-modules below hold, which is the largest directory in the family — so the DAG
// rule the whole concurrent build rests on quantified over everything except it.
// Stated without a figure deliberately: a count here would be a claim about a tree
// that grows every time a lane lands, and its going stale would be invisible.
// `panes/` now holds its composition file and nothing else, and this body is where
// the rest of the family is, reached by the same intra-family specifiers its siblings
// use.
//
// FOUR SUB-MODULES AND THE PANE ITSELF. `window/` derives which rows this pane holds,
// `find/` decides which of them a person is asking for, `replay/` decides which of them
// a position lets through, and `feed/` composes the three into the surface a reader
// scrolls.
//
// A SUB-MODULE PUBLISHES A DOOR ONLY WHERE ONE HAS READERS — the family's one
// criterion, stated the same way in `ledger/cards/index.ts` and
// `ledger/structure/index.ts`, and it is READERS and not directories: `window/` is
// read from three of them, `find/` and `replay/` from one apiece, and all three carry
// a door because every one of those readers is a module other than the door that
// declares them. `feed/` publishes none, because the one name that leaves it is read
// by exactly one module — `TimelinePane.tsx`, one directory up — and this file must
// reach the declaring module anyway or `console-no-barrel-chain` reports the second
// hop, which leaves such a door with no consumer at all.
//
// WHAT LEAVES THROUGH THIS DOOR IS WHAT `ledger/index.ts` MOUNTS. The pane's own
// pieces — the feed and its rows, the window and jump models, the notices — are read
// by their siblings inside this directory, deeply, which is what an intra-family
// import is for. A door is the list of names that LEAVE.

export { TimelinePane } from "./TimelinePane.js";
