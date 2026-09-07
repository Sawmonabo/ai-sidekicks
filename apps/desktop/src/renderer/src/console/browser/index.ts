// The browser family's door.
//
// The family owns the embedded browser: the pane's chrome, the page picker, the
// element-reference capture, and the two node-wide settings that govern them. What
// it owns TODAY is the pane's seat on the deck — the chrome is built once
// `Plan-023 §Console growth slate` rows 1, 2, and 4 leave the slate and the
// embedded-browser Type-2 ADR lands, and the shell it is built into is registered
// here so that arrival is an edit to a mounted pane rather than a new mount.
//
// WHY THE FAMILY REGISTERS, AND WHY THE BODY LIVES HERE TOO. `console/panes/` is a
// COMPOSITION site: it names every family and holds no body. A pane body is family
// code — it renders this family's surfaces and reads this family's models — so it
// lives in `browser/pane/` beside them, and the registration is the family's own.
// Parking it under `panes/` put ~950 lines outside the DAG both view-family layering
// rules subtract that path from, so a terminal body importing this family's registry
// was a green build. Here the isolation rules govern it like any other family module.
//
// WHAT THE FAMILY HOLDS, GROUPED BY SEAM. The family held its modules flat over five
// concerns, and its own CSS had already named four of them — which is the argument
// this grouping makes in code: a reader looking for the pane's chrome should not
// scroll past the partition table to reach it. Each is a sub-module directory reached
// by deep intra-family specifiers; the door below is unchanged. The count of modules
// is deliberately not stated: it moves with every module the family adds, and what
// the argument rests on is the five concerns, which the directories below are.
//
//   • `pane/` — the deck's browser body and the reads only it makes: the pane
//     (`BrowserPane.tsx`), its chrome control and address field, the act sequence the
//     wire is driven through, the geometry binding, the reported-navigation read,
//     the keyboard handback, the pane's addressing triple, and the descriptor the
//     door below registers (`pane/browser-pane-body.ts`, loaded as its own chunk).
//   • `geometry/` — the rect the main-process view host is positioned by, and every
//     reading that makes it honest: the publisher, the motion and animation samplers,
//     the ancestry watch, the occlusion registry, and the host resolution. It renders
//     nothing, which is why it carries no sheet.
//   • `settings/` — chapter 13.16's page: the policy rows and their switches, the
//     partition table with its rows, and the clear control with its arming rounds.
//   • `cards/` — one shell for a capture, a download, and a page tool call, with the
//     ingest meter inside it.
//   • `bounds/` — chapter 12.10's resource-ceiling table: the bound vocabulary, the
//     figure chokepoint each unit renders through, and the rows and meter that show
//     it inside the pane's disclosure.
//
// The family sits above the seats door in the console's DAG and imports no sibling
// view family through any other path.

// THIS FAMILY'S STYLESHEETS ARE NOT IMPORTED HERE. They enter at
// `pane/browser-pane-body.ts`, the one chunk root this family has, and that module's
// header states the placement rule and the five sheets it carries. Importing them at
// this door would put every rule the browser surfaces need on the initial document for
// a session that never opens the pane — the exact cost the loader below was written to
// avoid, paid in CSS instead of JS.
//
// THE MOVE WAS ADMITTED BY MEASUREMENT AND NOT BY THE SHAPE OF THE FILE. A sheet may
// only travel behind a chunk boundary when no other family declares any class it
// declares: two families declaring one class at equal specificity are resolved by LOAD
// ORDER, so deferring such a sheet silently restyles the other family's surface. That is
// not hypothetical — `runs/index.ts` carries the measurement of it happening. None of
// this family's five sheets declares a class any other family declares, and
// `test/console/architecture/stylesheet-selector-owners.test.ts` is the census that
// says so and fails if that stops being true.

import type { ConsolePaneRegistry } from "../seats/index.js";

/**
 * Claim the browser family's pane kinds.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsolePanes`' reason: a test composes into a registry it owns, and an
 * auxiliary window composes a different subset without a second code path.
 */
export function registerBrowserPanes(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "browser",
    owner: "browser",
    // A LOADER AND NOT A `render`. Nothing this family draws is on the flagship first
    // paint — the pane opens from the sidebar or the palette — so the whole subtree
    // travels as its own chunk and the launch does not pay for it. The specifier is
    // written here, at the registration, so the boundary is visible where the claim is
    // made rather than hidden inside the body module.
    body: () => import("./pane/browser-pane-body.js"),
  });
}
