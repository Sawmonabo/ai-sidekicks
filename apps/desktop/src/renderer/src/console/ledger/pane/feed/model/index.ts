// The feed's model door: what the feed works out, published to what draws it.
//
// A DOOR HERE BECAUSE THIS DIRECTORY HAS A SIBLING READER, which is the whole of the
// condition `apps/desktop/AGENTS.md` §Module shape states — no sibling reader means no
// door, and one sibling reader means a door publishing what that sibling takes.
// `row-offers/` next door is the same rule applied one directory over: it carries a
// door because the row renderer draws its control and the feed binds it, and both are
// modules other than the ones that declare those names.
//
// THE DIRECTION, MEASURED RATHER THAN ASSUMED (TypeScript parser over every module
// under `feed/`, 2026-09-08): `surface/` reaches `model/` on nine edges — seven from
// production modules and two from suites — and `model/` reaches `surface/` on none, so
// the pair is one-directional and this is the side that publishes.
//
// AND IT PUBLISHES EXACTLY WHAT THOSE THREE READERS TAKE. `LedgerFeed.tsx` takes the
// follow seat, the palette's acts, the window chain and the find-and-jump system;
// `LedgerFeedHeader.tsx` takes the find-and-jump surface shape; `LedgerFeedRow.tsx`
// takes the superseded disclosure shape and the chapter density. Nothing else goes on
// it, and the two names left off show both halves of why. `foldChapterHeaders` is
// imported by suites only, so a line for it is a door line no production module reads
// and the barrel census fails it outright. `narrowChapterToAdmittedRows` IS read in
// production — by `pane/find/ledger-narrowing.ts`, which is not a sibling of this
// directory — so a line for it would pass that census and still be wrong: a door
// publishes what a SIBLING takes, and a reader elsewhere in the family reaches the
// module that declares the name by its own deep specifier. A door is never widened for
// symmetry.
//
// NOTHING IS RE-EXPORTED THROUGH ANOTHER DOOR. Every line below names the module that
// DECLARES the symbol, which is what keeps `console-no-barrel-chain` satisfied and
// what keeps the ledger family's own door re-exporting from declaring modules rather
// than through this one.

export { useActorFollowSeat } from "./ledger-actor-follow-seat.js";
export { useLedgerStructureActs } from "./ledger-feed-acts.js";
export { useLedgerFeedWindows } from "./ledger-feed-windows.js";
export { useLedgerFindAndJump, type LedgerFindAndJump } from "./ledger-feed-find-jump.js";
export { type LedgerSupersededBandDisclosure } from "./ledger-superseded-fold.js";
export { densityFor } from "./ledger-chapter-fold.js";
