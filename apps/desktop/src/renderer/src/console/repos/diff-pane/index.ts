// The diff pane's door.
//
// One directory, one barrel, whatever the module count behind it — the rule every
// console family obeys. What crosses this sub-module's boundary is the ledger card's
// registration and nothing else.
//
// `DiffPane` IS DELIBERATELY NOT ON IT. The pane is loader-backed, so its one reader is
// `diff-pane-body.ts` — a module in this directory, which reaches the component by its
// own deep specifier. A door line for it would be a dead export the barrel census
// fails, and it would also be the edge that defeated the boundary: a module reachable
// both statically, through this door, and dynamically, through the loader, is assigned
// to the STATIC chunk, so the whole pane would have stayed on the initial import graph
// while the lazy chunk shrank to a re-export of it.
//
// THE SHEET ENTERS HERE, because this directory owns it. `apps/desktop/AGENTS.md`
// keys that rule on ownership rather than on depth: a directory carrying a door owns
// itself, and this one does. The family door imported `diff.css` for a while instead,
// which read as the tidier shape and was the one thing the rule names — one directory
// being the reason another is styled. Nothing about the graph turns on the move:
// `repos/family-bodies.ts` reaches this barrel statically, so the sheet is present
// whenever the family door is, and it still lands once.

import "./diff.css";

// The ledger's `diff` inline-card body. Exported as the REGISTRATION rather than
// the component, because the seat is filled by a call and a family barrel that
// exported the component would invite a sibling to mount it directly — which is
// the import across view families the seats exist to prevent.
export { registerInlineDiffCardBody } from "./InlineDiffCard.js";
