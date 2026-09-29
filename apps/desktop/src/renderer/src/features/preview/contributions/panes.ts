// The browser family's door.
//
// The family owns the embedded browser: the pane's chrome (the tab strip, the address
// line and the viewport a native view is placed over), the geometry that positions that
// view, the keyboard handback, and the two node-wide settings switches. The deck's seat
// for the pane is registered here.
//
// WHY THE FAMILY REGISTERS, AND WHY THE BODY LIVES HERE TOO. `console/panes/` is a
// composition site: it names every family and holds no body. A pane body is family code,
// because it renders this family's surfaces and reads this family's models, so it lives
// in `browser/pane/` beside them and the registration is the family's own. The isolation
// rules govern it like any other family module.
//
// WHAT THE FAMILY HOLDS, GROUPED BY SEAM. Each directory is reached by deep intra-family
// specifiers; the door below is unchanged.
//
//   • `pane/` — the deck's browser body and the reads only it makes: the pane
//     (`BrowserPane.tsx`), its chrome control and address field, the act sequence, the
//     geometry binding, the navigation and page-list readings, the keyboard handback,
//     and the descriptor the door below registers (`pane/browser-pane-body.ts`, loaded
//     as its own chunk).
//   • `geometry/` — the rect the main-process view host is positioned by, and every
//     reading that makes it honest: the publisher, the motion and animation samplers,
//     the ancestry watch, the overlay observation this pane registers as airspace, and
//     the host resolution. The registry those observations land in is `core/`'s, because
//     every overlay primitive registers into the same one. It renders nothing, which is
//     why it carries no sheet.
//   • `settings/` — the settings page: the policy rows and their switches, and the chunk
//     root `console/browser-settings-page.ts` registers it through
//     (`settings/browser-settings-page-body.ts`). Nothing here leaves the door: the page
//     is composed at the console root, which is where the settings board is named.
//
// The family sits above the seats door in the console's DAG and imports no sibling
// view family through any other path.

// NONE OF THIS FAMILY'S STYLESHEETS ENTERS HERE, and that is a fact about the graph
// rather than about the directory. `console/panes/index.ts` calls `registerBrowserPanes`
// from the entry chunk, so every module this door reaches is on the initial import graph
// and a sheet named here lands on every launch, including the sessions that never open a
// page. Every one dresses surfaces nothing on that graph can render: the pane opens from
// the sidebar or the palette, and the settings section is reached two acts after the
// first paint, by navigating to settings and then choosing it.
//
// SO EACH ENTERS AT ONE OF THE FAMILY'S TWO CHUNK ROOTS. `pane/browser-pane-body.ts`
// names `pane/pane.css`, `pane/chrome/chrome.css` and `controls.css`;
// `settings/browser-settings-page-body.ts` names `settings/settings.css`.
//
// A sheet may only travel behind a chunk boundary when no other family declares any
// class it declares: two families declaring one class at equal specificity are resolved
// by load order, so deferring such a sheet silently restyles the other family's surface.
// Every class in this family's four sheets carries the `meridian-browser-` prefix, and
// no other family's sheet declares one.

import type { ConsolePaneRegistry } from "@renderer/console/seats/index.js";

export {
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  ChordMirrorPublication,
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  composeChordMirrorKey,
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  readChordMirrorKey,
} from "../handback/chord-mirror.js";

/**
 * Claim the browser family's seats.
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
    body: () => import("../preview-pane-body.js"),
  });
}
