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
// WHAT THE FAMILY HOLDS, GROUPED BY SEAM. The family held 30 flat modules over five
// concerns, and its own CSS had already named four of them — which is the argument
// this grouping makes in code: a reader looking for the pane's chrome should not
// scroll past the partition table to reach it. Each is a sub-module directory reached
// by deep intra-family specifiers; the door below is unchanged.
//
//   • `pane/` — the deck's browser body and the reads only it makes: the pane
//     (`BrowserPane.tsx`), its chrome control and address field, the act sequence the
//     wire is driven through, the geometry binding, the reported-navigation read,
//     the keyboard handback, the pane's addressing triple, and the descriptor the
//     door below registers (`pane-descriptor.ts`).
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

// The family's stylesheets are imported HERE and nowhere else, which is the rule
// `primitives/index.ts` and `frame/index.ts` already follow: one edge into each sheet
// per bundle, and no surface can render a shape whose CSS never arrived.
//
// FIVE SHEETS AND NOT ONE, because one file carried five surfaces — the settings
// page, the shared controls, the produced-object cards, the pane shell, and the
// bounds table — and a reader looking for the pane's chrome had to scroll past the
// partition table to find it. They are imported one by one rather than through a
// `@import` chain so every edge into this family's CSS is visible at the door, which
// is what makes "imported here and nowhere else" checkable rather than promised.
import "./styles/browser-settings.css";
import "./styles/browser-controls.css";
import "./styles/browser-cards.css";
import "./styles/browser-pane.css";
import "./styles/browser-bounds.css";

import type { ConsolePaneRegistry } from "../seats/index.js";
import { BROWSER_PANE_DESCRIPTOR } from "./pane/pane-descriptor.js";

/**
 * Claim the browser family's pane kinds.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsolePanes`' reason: a test composes into a registry it owns, and an
 * auxiliary window composes a different subset without a second code path.
 */
export function registerBrowserPanes(registry: ConsolePaneRegistry): void {
  registry.register(BROWSER_PANE_DESCRIPTOR);
}
