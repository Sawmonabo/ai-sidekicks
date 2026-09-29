// The browser section: the rail entry, the search vocabulary, and the mount.
//
// WHY THIS MODULE HOLDS NO BODY, AND WHY IT SITS AT THE CONSOLE ROOT
//
// The browser's section lives in SETTINGS, while the surface that renders it is the
// browser family's — its subject is the browser, which is that family's vocabulary.
// Naming two view families is a composition site's job, so the one line between them
// lives here rather than inside either family, where `console-view-family-isolation`
// would fail the edge in whichever direction it was written.
//
// THE BROWSER FAMILY IS REACHED AS A CHUNK ROOT, NOT THROUGH ITS DOOR
//
// The family's door, `./browser/index.js`, is imported EAGERLY by
// `console/panes/index.ts`, which calls `registerBrowserPanes` to claim the deck's
// `browser` kind, so everything the door statically reaches is in the entry chunk.
// Naming the door from a LOADER would change nothing: a module already assigned to the
// static chunk is what a dynamic import of it resolves to.
//
// So the specifier below names a module the eager graph does not reach —
// `./browser/settings/browser-settings-page-body.js`, the page's own chunk root, which
// owns the sheet that dresses it. That it is a deep path is not this file bending the
// door rule: a chunk root is not a symbol a barrel can publish, and
// `console-cross-family-deep-import` is scoped to importers inside a family directory
// — a composition site directly under `console/`, which this file is, is not one of
// them.
//
// THE SETTINGS FAMILY IS REACHED for exactly one declared thing — `SettingsPageRegistrar`,
// the one-method view of its registry. Not the registry class, not the section
// vocabulary, and not the descriptor shape, so nothing here can read the rail or
// unregister a sibling lane's page. That import is deep rather than through
// `settings/index.js` because the settings door composes this file's registration, and a
// type line back through it closes a module cycle `no-circular` fails on.

import type { SettingsPageRegistrar } from "@renderer/features/settings/settings-pages.js";

/** The lane that owns this registration, so an unfilled section names someone. */
const OWNER = "settings-browser";

/**
 * Claim the browser section.
 *
 * The body takes nothing from the page context: it renders the page heading and reads
 * nothing, so the browser family never names the settings family's context type to
 * satisfy this registration.
 *
 * `label` and `keywords` stay HERE rather than travelling with the body, and that is
 * what makes the loader form usable at all: the rail lists every registered section and
 * the search index ranks them before a person has opened any of them, so a page whose
 * name arrived with its chunk would be unfindable until it had already been found.
 */
export function registerBrowserSettingsPage(registry: SettingsPageRegistrar): void {
  registry.register({
    section: "browser",
    owner: OWNER,
    label: "Browser",
    keywords: [
      "web",
      "site data",
      "cookies",
      "storage",
      "partitions",
      "file boundary",
      "page tools",
      "clear",
    ],
    body: () => import("@renderer/features/settings/pages/browser/browser-settings-page-body.js"),
  });
}
