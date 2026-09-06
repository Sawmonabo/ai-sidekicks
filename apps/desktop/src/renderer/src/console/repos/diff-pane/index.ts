// The diff pane's door.
//
// One directory, one barrel, whatever the module count behind it — the rule every
// console family obeys. The pane's body is reached only through here: the repos
// family composes it into a `ConsolePaneDescriptor` in its own barrel, so the
// registration and the component never have to know about each other.
//
// THE SHEET ENTERS HERE, because this directory owns it. `apps/desktop/AGENTS.md`
// keys that rule on ownership rather than on depth: a directory carrying a door owns
// itself, and this one does. The family door imported `diff.css` for a while instead,
// which read as the tidier shape and was the one thing the rule names — one directory
// being the reason another is styled. Nothing about the graph turns on the move:
// `repos/family-bodies.ts` reaches this barrel statically, so the sheet is present
// whenever the family door is, and it still lands once.

import "./diff.css";

export { DiffPane } from "./DiffPane.js";

// The ledger's `diff` inline-card body. Exported as the REGISTRATION rather than
// the component, because the seat is filled by a call and a family barrel that
// exported the component would invite a sibling to mount it directly — which is
// the import across view families the seats exist to prevent.
export { registerInlineDiffCardBody } from "./InlineDiffCard.js";
