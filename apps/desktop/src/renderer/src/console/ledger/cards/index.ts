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

export { projectFixtureShellRows } from "./fixture-shell-projection.js";
