// The ledger frame's door — the scroll chokepoint, the reading anchor, the reveal
// engine, the row window, the window cap, and the error slots.
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
// the feed needs at once — the chokepoint, the anchor, the row window, and the cap.
// A surface that wanted, say, the reading anchor without the chokepoint would be
// asking to decide where a reader is standing and then be unable to keep them
// there. The reveal engine and the error slots are the two that stand alone: one
// publishes text and the other holds refusals, and neither needs a viewport.
//
// The bounds every one of them spends live in `frame-bounds.ts`, on the terms
// `core/constants.ts` sets for a view family's own module.

// WHY EVERY LINE BELOW IS A STAR RE-EXPORT rather than a named one. The dead-code
// gate reports an unused re-export at the SPECIFIER, so a named barrel written
// ahead of its consumers is a list of findings — and the only exemption for that is
// a `@consumedBy` tag, which is for a symbol a DIFFERENT task will import. Every
// consumer of this door is a sibling piece of this same task (the pane that mounts
// the viewport, the structure that drives the rail, the cards that stream into it),
// so a tag here would name the task that already owns the file. `ledger/index.ts`
// and `workspace/index.ts` take the same form for the same reason.
//
// The comment on each line is the table a named barrel would have been: what the
// module carries, in DAG order, low to high.

export * from "./frame-bounds.js"; // the caps, windows, and budgets everything here spends
export * from "./reveal-gate.js"; // commit modes and the literal-safety predicate
export * from "./rope-smoother.js"; // one lane's text, as parts and a cursor
export * from "./scroll-quantization.js"; // whether this display rounds a written offset
export * from "./scroll-chokepoint.js"; // the console's only scroll writer, and its geometry
export * from "./reading-anchor.js"; // following, reading, and the rows a reader is holding
export * from "./row-window.js"; // which rows are mounted, and where they sit
export * from "./window-cap.js"; // what the log keeps, and when it may let go
export * from "./reveal-engine.js"; // N lanes streaming on one frame budget
export * from "./ErrorSlot.js"; // ranked per-kind slots and the row-group boundary
export * from "./viewport-controller.js"; // the wiring, and the hook a view reads it through
export * from "./LedgerViewport.js"; // the feed itself
