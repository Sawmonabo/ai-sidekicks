// The diff pane's door.
//
// One directory, one barrel, whatever the module count behind it — the rule every
// console family obeys. The pane's body is reached only through here: the repos
// family composes it into a `ConsolePaneDescriptor` in its own barrel, so the
// registration and the component never have to know about each other.
//
// The stylesheet is NOT imported here. This directory and `repos/artifact-pane/` are
// two of the family's seven sub-modules, and the family is reached through one door:
// `repos/index.ts` imports all eight of the family's sheets, this directory's own
// `diff.css` among them. A sheet imported from each sub-module door would land several
// times in the graph and its presence would depend on which door the bundler reached
// first.

export { DiffPane } from "./DiffPane.js";

// The ledger's `diff` inline-card body. Exported as the REGISTRATION rather than
// the component, because the seat is filled by a call and a family barrel that
// exported the component would invite a sibling to mount it directly — which is
// the import across view families the seats exist to prevent.
export { registerInlineDiffCardBody } from "./InlineDiffCard.js";
