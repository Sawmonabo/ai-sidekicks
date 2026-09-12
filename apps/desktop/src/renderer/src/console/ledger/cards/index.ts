// The ledger's card door — three names and the reading type two of them speak, because
// that is what leaves.
//
// All of it is the PANE's: the shell projection it builds a window from, the ask
// terminals that window folds, and the provider that hands them to the ask rows the
// seat mounts. The fold and its channel leave together because they are one seam — the
// row model derives, the feed publishes, the card reads — and a door that carried only
// one of them would leave the other reached by a path this file cannot see.
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
// fixture rows that stand in until the real ones land, which the change that imports
// them deletes as a directory).
//
// A SUB-MODULE PUBLISHES A DOOR ONLY WHERE ONE HAS READERS — the family's one criterion,
// stated the same way in `ledger/pane/timeline-pane-body.ts` and `ledger/structure/index.ts`, and it
// is READERS and not directories: a door earns its place from the modules outside that
// reach it, however few, because each of them would otherwise name a file rather than a
// seam. `ansi/` has none — every reader of it is a sibling inside this directory, which
// is what a deep intra-family specifier is for — so it carries no `index.ts` at all.
// `bodies/` does have them, counted rather than assumed: the two card frames at this root
// and four modules under `shell/`, which is why that directory carries a door and why the
// rules it renders are ITS sheet rather than a section of this one. `shell/` has exactly
// one reader and it is THIS door's own family door, which must reach the declaring module
// anyway or `console-no-barrel-chain` reports the second hop, so a door there would have
// no consumer at all — which `barrel-census` and the dead-code gate both fail.

// The sheet this directory owns, imported by its own door. The three sub-modules that
// carry doors of their own — `markdown/`, `tool-families/` and `bodies/` — each import
// their own sheet there, because a door is what makes a directory an owner.
import "./cards.css";

export { projectFixtureShellRows } from "./shell/fixture-shell-projection.js";
export { LedgerAskTerminalProvider } from "./bodies/AskTerminalProvider.js";
export { deriveDriverAskTerminals, type DriverAskReading } from "./bodies/input-ask.js";
