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
// WHY EVERY LINE BELOW IS A STAR RE-EXPORT, which is `ledger/frame/index.ts`'s form
// and its reason: the dead-code gate reports an unused re-export at the SPECIFIER,
// so a named barrel written ahead of its consumers is a list of findings, and the
// only exemption for that is a `@consumedBy` tag — which is for a symbol a DIFFERENT
// task will import. Every consumer of this door is a sibling piece of this same task
// (the pane that mounts the rail, the frame that folds the chapters, the deck that
// reveals the replay dock), so a tag here would name the task that already owns the
// file.
//
// The comment on each line is the table a named barrel would have been: what the
// module carries, in DAG order, low to high.

export * from "./constants.js"; // the caps and geometry every module here spends
export * from "./chapters.js"; // one run's rows, folded, and which chapters are open
export * from "./seams.js"; // epochs as geography, one row at a time
export * from "./superseded-bands.js"; // which rows a rewind put behind it, kept and dimmed
export * from "./rail-model.js"; // the minimap's marks, with no DOM in them
export * from "./ProvenanceRail.js"; // the canvas, the hit strip, and the keyboard walk
export * from "./replay-model.js"; // playback over the frozen clock
export * from "./ReplayControls.js"; // the docked scrub-and-play control
export * from "./filters.js"; // participant and family narrowing, and the jumps
export * from "./find-model.js"; // the matcher, and the boundary it states
export * from "./FindInLedger.js"; // the find field itself
export * from "./structure-commands.js"; // what all of it contributes to the palette
