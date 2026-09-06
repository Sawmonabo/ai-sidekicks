// The sidekicks section: the rail entry, the search vocabulary, and the mount.
//
// WHY THIS MODULE HOLDS NO BODY
//
// The saved-sidekick page is the agents family's — its subject is an agent's
// definition, which is that family's vocabulary — and the design puts it in
// SETTINGS, reachable from the in-session attach picker. Those two facts are not in
// tension: the body lives where its vocabulary is and the rail entry lives where a
// person looks for it, and this file is the one line between them. It re-authors
// nothing and renders no markup of its own.
//
// WHY IT IS A `.ts` AND NOT A `.tsx`
//
// Every other module in this directory owns a component and is named for it. This
// one owns a REGISTRATION, so it takes the kebab-case module name the package's
// structure rules give a module named for the noun it owns, and it composes the
// element through `createElement` rather than growing a JSX body that would make it
// look like a second page.
//
// WHY IT SITS AT THE CONSOLE ROOT
//
// It names TWO view families — the settings page registry it registers into, and
// the agents page body it registers — and a view family may name no other:
// `console-view-family-isolation` in `.dependency-cruiser.mjs` fails that edge. The
// gate subtracts the console's COMPOSITION SITES from both ends of that rule, and a
// file directly under `console/` is one, which is exactly what a file whose whole
// body is one registration is. It lived in `settings/pages/` while the rule did not
// exist yet; nothing about what it does has changed.
//
// EACH FAMILY IS STILL REACHED THROUGH ITS DOOR
//
// `./agents/index.js`, never `./agents/definitions/SidekickDefinitionsPage.js`. A deep
// import would work
// and would also be the first one, which is how a barrel stops being the boundary it
// exists to be.
//
// THE SETTINGS FAMILY IS REACHED FOR EXACTLY ONE DECLARED THING: `SettingsPageRegistrar`,
// the one-method view of its registry that family declares for the page registered
// from outside it. Not the registry CLASS, which the door withholds on purpose, and
// not the section vocabulary or the descriptor shape — so nothing here can read the
// rail or unregister a sibling lane's page. The import is deep rather than through
// `settings/index.js` because that door imports THIS file to compose the page, and a
// type line back through it closes a module cycle `no-circular` fails on.

import { createElement } from "react";

import { SidekickDefinitionsPage } from "./agents/index.js";
import type { SettingsPageRegistrar } from "./settings/settings-page-registry.js";

/** The lane that owns this registration, so an unfilled section names someone. */
const OWNER = "collaboration-settings-sidekicks";

/**
 * Claim the sidekicks section.
 *
 * The body takes the BRIDGE and nothing else from the page context. It reads the
 * saved-sidekick registry on mount and deletes through the same port, so the seam
 * hands it the one member those calls need; `openSection` and `retainedSessionId` are
 * deliberately not threaded, because the page navigates nowhere and its subject is
 * node-local rather than scoped to whichever session this window happens to hold.
 */
export function registerSidekicksPage(registry: SettingsPageRegistrar): void {
  registry.register({
    section: "sidekicks",
    owner: OWNER,
    label: "Sidekicks",
    keywords: [
      "agents",
      "definitions",
      "presets",
      "saved agents",
      "instructions",
      "goal",
      "tools",
      "attach",
    ],
    render: (context) => createElement(SidekickDefinitionsPage, { bridge: context.bridge }),
  });
}
