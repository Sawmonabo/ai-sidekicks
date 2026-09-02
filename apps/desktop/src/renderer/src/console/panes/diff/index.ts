// The diff pane's door.
//
// One directory, one barrel, whatever the module count behind it — the rule every
// console family obeys. The pane's body is reached only through here: the repos
// family composes it into a `ConsolePaneDescriptor` in its own barrel, so the
// registration and the component never have to know about each other.
//
// The stylesheet is NOT imported here. This directory and `panes/artifact/` are two
// of the three directories `T-023p-1C-5` builds, and one family carries one sheet:
// `repos/repos.css`, imported from `repos/index.ts`, which is the module that
// composes both panes. A sheet imported from each of three doors would land three
// times in the graph and its presence would depend on which door the bundler
// reached first.

export { DiffPane } from "./DiffPane.js";
