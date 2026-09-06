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
// WHAT LEAVES. The replay state a feed and a rail both read, its hook, and the two
// reveal hooks the feed composes. The engine, the freeze, and the fixtures stop here.

export { useReplayAnchorRowId, useReplayRevealedRows } from "./ledger-replay-reveal.js";
export { useLedgerReplay, type LedgerReplayState } from "./ledger-replay-window.js";
