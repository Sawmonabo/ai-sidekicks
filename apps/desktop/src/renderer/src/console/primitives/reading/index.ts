// The reading sub-module door: what a SIBLING inside `primitives/` takes from here.
//
// The incomplete-reading vocabulary, its notice shape, and the two components that
// put one on screen. A reading is a fact about a READ — how much of it landed and
// why the rest did not — which is why it sits beside the absence vocabulary rather
// than inside it.
//
// ONE EDGE EARNED THIS DOOR, and it runs the other way from the one a reader
// expects: `announce/reading-announcement.ts` folds a `ReadingState` into the
// sentence it speaks, so the announcer reads the vocabulary and this directory reads
// nothing of the announcer's. The set below is exactly what that module takes.
//
// AND THE SHEET IS NOT HERE, deliberately, for the same reason the refusal door's is
// not. `partial-read.css` dresses `PartialRead` and the `ReadingNotice` nested inside
// it, and both leave through `primitives/index.ts` from their declaring modules — while
// the one edge into THIS directory is the announcer's line above, which takes the
// vocabulary and nothing that wears those rules. Owned by this door the sheet's only
// way onto the document was that line, so a family rendering a partial-read box was
// styled by an edge that has nothing to do with the box, and the day the announcer
// stopped folding a `ReadingState` the rules would have gone with it. The sheet sits at
// `primitives/partial-read.css` beside the door that publishes what it styles, which is
// what its own header has always said, and ownership follows it there rather than
// staying with the deeper barrel: `apps/desktop/AGENTS.md` §Module shape's "either move
// the entry with the sheet or leave the sheet at the door".

export type { PartialReadNotice, ReadingState } from "./partial-read.js";
export { partialReadNotices } from "./partial-read.js";
