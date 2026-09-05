// The ledger's card door — and it publishes one name, because one is what leaves.
//
// EVERY LINE IS A NAMED RE-EXPORT AND THE LIST IS SHORT ON PURPOSE. The cards, the
// machine body, the streaming pipeline and the fixture shell are reached by their
// siblings inside this directory, deeply, which is what an intra-family import is
// for; a door is what a name uses to LEAVE. Until this file was named it forwarded
// thirteen modules with `export *`, so the census could not enumerate what it
// published and no reader could tell which names were the family's own interface from
// which were incidental.
//
// `shellRowId` IS NOT ON THIS LIST, and it was: a door line exists for a PRODUCTION
// reader, and the only thing outside this directory that ever asked for it is the
// timeline family's fixture scaffolding. A door widened for a test is a door widened
// for testing, so that module reaches `fixture-shell-projection.ts` directly and this
// line publishes what production reaches.
//
// THE MARKDOWN PIPELINE IS NOT RE-EXPORTED THROUGH THIS DOOR. `markdown/index.js` is
// a sub-barrel — those modules are one job, and `apps/desktop/AGENTS.md` puts a job
// that outgrows one file in a module directory rather than a flat pile — and the cards
// beside it reach it deep. Forwarding it here as well would be a barrel chain: a
// family door publishing names it never declared, whose home takes two hops to find,
// which is what `structure:layering`'s `console-no-barrel-chain` rule reports.
//
// AND IT IS NO LONGER THE ONLY SUB-MODULE. What remains at this root is THE CARDS — the
// message and tool frames, the receipt rows, the inline seat — and the models every one
// of them spends: which family a row belongs to, what a card may hold, what a body costs,
// which run a row is attributed to, and how a wire payload is read. Three jobs that are
// not that sit in directories of their own, on the precedent `markdown/` set: `bodies/`
// (what goes INSIDE a frame), `ansi/` (the terminal-output pipeline), and `shell/` (the
// fixture rows that stand in until Plan-013's real ones land, which the PR that imports
// them deletes as a directory).
//
// A SUB-MODULE PUBLISHES A DOOR ONLY WHERE ONE HAS READERS. `bodies/` does — both card
// frames choose between its two. `ansi/` and `shell/` are each read from outside by one
// module, and `shell/` by this door, which must reach the declaring module anyway; a door
// with one reader is a second name for one edge, and a door with none is what
// `barrel-census` and the dead-code gate both fail.

export { projectFixtureShellRows } from "./shell/fixture-shell-projection.js";
