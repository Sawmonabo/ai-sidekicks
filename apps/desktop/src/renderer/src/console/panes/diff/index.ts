// The diff pane's door.
//
// One directory, one barrel, whatever the module count behind it — the rule every
// console family obeys. The pane's body is reached only through here: the repos
// family composes it into a `ConsolePaneDescriptor` in its own barrel, so the
// registration and the component never have to know about each other.
//
// The stylesheet is NOT imported here. This directory and `panes/artifact/` are two
// of the three directories `T-023p-1C-5` builds, and the family is reached through
// one door: `repos/index.ts` imports `repos/repos.css`, which `@import`s this
// directory's own `diff.css`. A sheet imported from each of three doors would land
// three times in the graph and its presence would depend on which door the bundler
// reached first.

export { DiffPane } from "./DiffPane.js";

// The ledger's `diff` inline-card body. Exported as the REGISTRATION rather than
// the component, because the seat is filled by a call and a family barrel that
// exported the component would invite a sibling to mount it directly — which is
// the import across view families the seats exist to prevent.
export { registerInlineDiffCardBody } from "./InlineDiffCard.js";
