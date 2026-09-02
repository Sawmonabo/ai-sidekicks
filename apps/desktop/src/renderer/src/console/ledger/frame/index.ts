// The ledger frame's door — the scroll chokepoint, the reading anchor, the reveal
// engine, the virtualized row window, the window cap, and the error slots.
//
// WHAT "FRAME" MEANS HERE. Not the console's application frame (`console/frame/`),
// which is the shell a route mounts into. This is the ledger's own frame: the
// machinery that decides which rows exist, where they sit, how fast their text
// appears, and where the reader is standing while all of that changes. The rows
// themselves belong to Plan-013 and the cards to this family's own card door;
// nothing in this directory renders a Spec-013 entry type.
//
// The pieces here are separately testable and jointly useless, which is why
// `viewport-controller.ts` exists and why it is the only module that holds the four
// the feed needs at once — the chokepoint, the anchor, the measurement ledger, and
// the cap, with `@tanstack/react-virtual` bound underneath them all.
// A surface that wanted, say, the reading anchor without the chokepoint would be
// asking to decide where a reader is standing and then be unable to keep them
// there. The reveal engine and the error slots are the two that stand alone: one
// publishes text and the other holds refusals, and neither needs a viewport.
//
// The bounds every one of them spends live in `frame-bounds.ts`, on the terms
// `core/constants.ts` sets for a view family's own module.

// WHAT THIS DOOR CARRIES IS WHAT LEAVES THE DIRECTORY, AND NOTHING MORE.
//
// It used to be fourteen star re-exports, on the reasoning that a NAMED barrel
// written ahead of its consumers is just a list of dead-code findings. That was
// true when it was written and is not true now: the pane mounts the feed, so the
// consumers exist and can be counted. Counting them gives FOUR symbols — the feed
// component, the hook a view binds it through, the row shape both sides speak, and
// the per-row error boundary the cards wrap themselves in — and the star form was
// re-exporting seventy-six, every one of which the gate reported the moment
// anything reached this directory at all.
//
// The rest are not hidden, they are INTERNAL: `panes/timeline/` and this family's
// other subtrees reach them by their own module paths, which is what an
// intra-family import is for. A door is the list of things a stranger may hold, and
// widening it to every symbol a directory happens to define makes it a table of
// contents rather than a contract.

export { LedgerRowGroup } from "./ErrorSlot.js";
export { LedgerViewport } from "./LedgerViewport.js";
export { useLedgerViewport } from "./viewport-binding.js";
export { type LedgerViewportRow } from "./viewport-snapshot.js";
