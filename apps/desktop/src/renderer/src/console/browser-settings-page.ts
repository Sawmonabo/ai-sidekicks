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
// EACH FAMILY IS REACHED THROUGH ITS DOOR. `./browser/index.js` for the section, and
// the settings family for exactly one declared thing — `SettingsPageRegistrar`, the
// one-method view of its registry. Not the registry class, not the section vocabulary,
// and not the descriptor shape, so nothing here can read the rail or unregister a
// sibling lane's page. That import is deep rather than through `settings/index.js`
// because the settings door composes this file's registration, and a type line back
// through it closes a module cycle `no-circular` fails on.
//
// THE PAGE WAS BUILT AND MOUNTED NOWHERE. Every part of chapter 13.16 shipped —
// the policy rows, the partition table, the two-step clear and its arming rounds —
// and no board registered it, so the `browser` section stood on the rail's reserved
// arm and the whole surface was unreachable. This file is that registration.

import { createElement } from "react";

import { BrowserSettingsSection } from "./browser/index.js";
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
 * happens to hold.
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
    render: (context) => createElement(BrowserSettingsSection, { bridge: context.bridge }),
  });
}
