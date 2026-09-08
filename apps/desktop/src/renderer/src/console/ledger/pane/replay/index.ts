// The replay seam: a position over the loaded log, and which rows it lets through.
//
// THE SEAM THIS DIRECTORY OWNS. Replay sits between the two windows — it plays over
// the log the projection loaded and decides which of those rows the viewport is given,
// so a scrub moves what is on screen and find and the rail follow it down. Keeping
// that in one directory is what keeps the pipeline acyclic and legible: the walk owns
// the engine's lifetime, the freeze, and the set one replay is over, while the reveal
// beside it is a pure derivation over a window and a position, driven with no clock,
// no engine, and no mount.
//
// AND THE OTHER REPLAY. `ledger-gap-fill.ts` plays over the WIRE rather than over the
// loaded log — the re-subscribe a window asks for when it was told about entries it
// never received — and it is in this directory because it is the same act at the
// other end of the pipeline: a position, and which rows it lets through. Its surface is
// mounted by the family root, beside the resume reading, where the store and the
// registry are both in hand; the decision and the hook it composes stop here with the
// engine.
//
// AND IT IS NOT PUBLISHED HERE, WHICH IS A MEASUREMENT RATHER THAN A PREFERENCE. This
// door carried `LedgerGapFill` for that root, and that root is on the initial import
// graph — a door is an EDGE to every module it re-exports from, so one line for a
// banner that draws nothing on nearly every launch put the replay engine below it, the
// whole `structure/` door that engine reads through, and the cards those rows render
// as, on every one of them. The root names `./LedgerGapFill.js` directly now, which is
// the form `apps/desktop/AGENTS.md` §Module shape already states for a family door —
// it re-exports "from the module that DECLARES it, never through the inner barrel" —
// and what is left here is what a SIBLING under `pane/` takes.

export { useReplayAnchorRowId, useReplayRevealedRows } from "./ledger-replay-reveal.js";
export { useLedgerReplay, type LedgerReplayState } from "./ledger-replay-window.js";
