// The browser section: the rail entry, the search vocabulary, and the mount.
//
// WHY THIS MODULE HOLDS NO BODY, AND WHY IT SITS AT THE CONSOLE ROOT
//
// `sidekicks-settings-page.ts` beside it carries the reasoning in full and this file
// is the same shape: chapter 13.16 puts the browser's two node-wide switches and its
// site-data table in SETTINGS, while the surface that renders them is the browser
// family's — its subject is the browser, which is that family's vocabulary. Naming two
// view families is a composition site's job, so the one line between them lives here
// rather than inside either family, where `console-view-family-isolation` would fail
// the edge in whichever direction it was written.
//
// THE BROWSER FAMILY IS REACHED AS A CHUNK ROOT, NOT THROUGH ITS DOOR. This file named
// `./browser/index.js` and held the page component, which is what a cross-family import
// is supposed to look like — and it is exactly what put the page on every launch. That
// door is imported EAGERLY by `console/panes/index.ts` for the browser pane's seat, so
// everything it statically reaches is in the entry chunk; the page, its two reads, its
// partition table, its clear rounds and its two sheets rode there whether or not
// settings was ever opened. Naming the door from a LOADER would have changed nothing
// either: a module already assigned to the static chunk is what a dynamic import of it
// resolves to. So the specifier below names a module the eager graph does not reach —
// `./browser/settings/browser-settings-page-body.ts`, the page's own chunk root, which
// owns its sheet. That it is a deep path is not this file bending the door rule: a chunk
// root is not a symbol a barrel can publish, and `console-cross-family-deep-import` is
// scoped to importers inside a family directory, which a composition site directly under
// `console/` is not. `sidekicks-settings-page.ts` beside it takes the same form for the
// same reason.
//
// THE SETTINGS FAMILY IS REACHED FOR EXACTLY ONE DECLARED THING — `SettingsPageRegistrar`,
// the one-method view of its registry. Not the registry class, not the section vocabulary,
// and not the descriptor shape, so nothing here can read the rail or unregister a
// sibling lane's page. That import is deep rather than through `settings/index.js`
// because the settings door composes this file's registration, and a type line back
// through it closes a module cycle `no-circular` fails on.
//
// THE PAGE WAS BUILT AND MOUNTED NOWHERE. Every part of chapter 13.16 shipped —
// the policy rows, the partition table, the two-step clear and its arming rounds —
// and no board registered it, so the `browser` section stood on the rail's reserved
// arm and the whole surface was unreachable. This file is that registration.

import type { SettingsPageRegistrar } from "./settings/settings-page-registry.js";

/** The lane that owns this registration, so an unfilled section names someone. */
const OWNER = "collaboration-settings-browser";

/**
 * Claim the browser section.
 *
 * The body takes the BRIDGE and nothing else from the page context. Both of its reads
 * are node-wide — this node's browser policy, this node's stored partitions — so
 * neither the retained session nor the section opener is threaded: a page that
 * navigated nowhere and asked nothing per-session has no use for either, and handing
 * them over would suggest the answers were scoped to whichever session this window
 * happens to hold. The chunk root declares exactly that narrower parameter, which is
 * what keeps the browser family from naming the settings family's context type to
 * satisfy this registration.
 *
 * `label` and `keywords` stay HERE rather than travelling with the body, which is what
 * makes the loader form usable at all: the rail lists every registered section and the
 * search index ranks them before a person has opened any of them, so a page whose name
 * arrived with its chunk would be unfindable until it had already been found.
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
    body: () => import("./browser/settings/browser-settings-page-body.js"),
  });
}
