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
// FIVE SEAMS, FOUR OF THEM IN DIRECTORIES OF THEIR OWN. This was fifty-odd files on
// one floor with a door over nine names, which is a pile with a door rather than a
// module — and the concerns in it change for five different reasons:
//
//   • `reveal/` — how fast a row's text appears, and the lanes that pace it.
//   • `scroll/` — the one controller allowed to move the ledger, and how far.
//   • `viewport/` — which rows exist right now, and what the surface shows of them.
//   • `measurement/` — what has been measured, and where the reader is standing.
//   • row chrome, HERE — the mount, the group, the lease, the tail, the error slot:
//     what wraps one row, which is what the four above exist to place.
//
// Each directory states its own seam in its own header, and its neighbours reach it by
// a deep intra-family specifier. `reveal/` alone publishes NO door, and that is the
// corpus rule rather than an omission: a door exists for consumers, its only reader
// outside itself is this file, and this file must reach the DECLARING module or
// `console-no-barrel-chain` reports the second hop. A door with no consumer is what
// `barrel-census` and the dead-code gate both fail.
//
// The pieces are separately testable and jointly useless, which is why
// `viewport/viewport-controller.ts` exists and why it is the only module that holds the
// four the feed needs at once — the chokepoint, the anchor, the measurement ledger, and
// the cap, with `@tanstack/react-virtual` bound underneath them all.
// A surface that wanted, say, the reading anchor without the chokepoint would be
// asking to decide where a reader is standing and then be unable to keep them
// there. The reveal engine and the error slots are the two that stand alone: one
// publishes text and the other holds refusals, and neither needs a viewport.
//
// The ceilings every one of them spends are declared in `core/constants.ts`, the one
// module the `cap-constant-home` gate admits a bound in; the frame's other figures —
// the estimate, the tolerance, the epsilon, the overscan — stay in `frame-bounds.ts`
// at this root rather than joining `measurement/`, because all five seams spend them.

// WHAT THIS DOOR CARRIES IS WHAT LEAVES THE DIRECTORY, AND NOTHING MORE.
//
// It used to be fourteen star re-exports, on the reasoning that a NAMED barrel
// written ahead of its consumers is just a list of dead-code findings. That was
// true when it was written and is not true now: the pane mounts the feed, so the
// consumers exist and can be counted. What is listed below is that count and
// nothing beyond it — the feed component, the two hooks a view binds it through,
// the two per-row channels a row body reads, the row shape both sides speak, and
// the per-row error boundary the cards wrap themselves in — where the star form was
// re-exporting seventy-six, every one of which the gate reported the moment
// anything reached this directory at all.
//
// The rest are not hidden, they are INTERNAL: `ledger/pane/` and this family's
// other subtrees reach them through the four sub-module doors above or by their own
// module paths, which is what an intra-family import is for. A door is the list of
// things a stranger may hold, and widening it to every symbol a directory happens to
// define makes it a table of contents rather than a contract.
//
// EVERY LINE BELOW NAMES A DECLARING MODULE, never a sub-module door. Forwarding
// through a second `index.ts` would make a symbol's home two hops away and would let
// this door publish a name it never declared, which is what `console-no-barrel-chain`
// reports.

// The sheet this directory owns, imported by its own door: a family door reaching
// into a directory that carries one is the shape `apps/desktop/AGENTS.md` forbids.
import "./frame.css";

export { LedgerRowGroup } from "./LedgerRowGroup.js";
export { LedgerRowLeaseProvider, useLedgerRowLease } from "./RowLeaseProvider.js";
export { LedgerRowRevealProvider, useLedgerRowReveal } from "./reveal/RowRevealProvider.js";
export { useLedgerReveal } from "./reveal/reveal-binding.js";
export { LedgerViewport, type LedgerScope } from "./viewport/LedgerViewport.js";
export { type LedgerRowRenderer } from "./LedgerRowMount.js";
export { useLedgerViewport } from "./viewport/viewport-binding.js";
export { type LedgerViewportRow } from "./viewport/viewport-snapshot.js";
export { type LedgerRowLease } from "./row-lease-table.js";
