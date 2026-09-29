// The preview feature's pane contribution.
//
// The feature owns the embedded browser: the pane's content (the tab strip, the address
// line and the viewport a native view is placed over), the geometry that positions that
// view, and the keyboard handback. The deck's seat for the pane is registered here, and
// the body it names is `preview-pane-body.ts`, loaded as its own chunk.

// NONE OF THIS FEATURE'S STYLESHEETS ENTERS HERE, and that is a fact about the graph
// rather than about the folder. `app/registrations.ts` calls `registerPreviewPanes`
// from the entry chunk, so every module this file reaches is on the initial import graph
// and a sheet named here lands on every launch, including the sessions that never open a
// page. Every one dresses a surface nothing on that graph can render: the pane opens from
// the sidebar or the palette, never on first paint.
//
// SO EACH ENTERS BEHIND THE BODY'S CHUNK BOUNDARY. `preview-pane-body.ts` names
// `controls.css`, which the pane's controls share, and `PreviewPaneContent.tsx` and
// `PageTabStrip.tsx` each import their own sheet.
//
// A sheet may only travel behind a chunk boundary when no other feature declares any
// class it declares: two features declaring one class at equal specificity are resolved
// by load order, so deferring such a sheet silently restyles the other feature's surface.
// Every class in this feature's three sheets carries the `meridian-preview-` prefix, and
// no other feature's sheet declares one of them.

import type { PaneRegistry } from "@renderer/console/seats/index.js";

export {
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  ChordMirrorPublication,
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  composeChordMirrorKey,
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  readChordMirrorKey,
} from "../handback/chord-mirror.js";

/**
 * Claim the preview pane's seat.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerFeatureContributions`' reason: a test composes into a registry it owns, and an
 * auxiliary window composes a different subset without a second code path.
 */
export function registerPreviewPanes(registry: PaneRegistry): void {
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
