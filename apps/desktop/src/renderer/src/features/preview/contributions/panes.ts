// The preview feature's pane contribution: registers the `browser` kind, whose body
// (`preview-pane-body.ts`) loads as its own chunk.
//
// None of the feature's stylesheets is imported here: the entry chunk calls
// `registerPreviewPanes`, so a sheet named here would load on every launch. They enter behind
// the body's chunk boundary instead, which is safe because every class carries the
// `meridian-preview-` prefix and no other feature's sheet declares one.

import type { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";

export {
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  ChordMirrorPublication,
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  composeChordMirrorKey,
  /** @consumedBy the preview pane's handback, which tells the host the chords the page claims */
  readChordMirrorKey,
} from "../handback/chord-mirror.js";

/**
 * Registers the preview pane's kind. Takes the registry rather than a module-scope singleton so
 * a test composes into its own.
 */
export function registerPreviewPanes(registry: PaneRegistry): void {
  registry.register({
    kind: "browser",
    owner: "preview",
    // A loader, not a `render`: nothing here is on first paint, so the subtree is its own chunk.
    // The specifier sits at the registration so the boundary is visible where it is claimed.
    body: () => import("../preview-pane-body.js"),
  });
}
