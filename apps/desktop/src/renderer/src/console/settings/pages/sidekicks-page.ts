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
// THE IMPORT CROSSES A FAMILY BOUNDARY THROUGH THE DOOR
//
// `../../agents/index.js`, never `../../agents/DefinitionsPage.js`: settings and
// agents are sibling view families, and a cross-family import goes through the
// other family's single barrel. A deep import would work and would also be the
// first one, which is how a barrel stops being the boundary it exists to be.

import { createElement } from "react";

import { SidekickDefinitionsPage } from "../../agents/index.js";
import type { SettingsPageRegistry } from "../settings-page-registry.js";

/** The lane that owns this registration, so an unfilled section names someone. */
const OWNER = "collaboration-settings-sidekicks";

/**
 * Claim the sidekicks section.
 *
 * The body takes no props — it reads nothing, writes nothing, and navigates
 * nowhere, because every verb it would use is unregistered — so the page context is
 * deliberately not threaded into it. The day the registry read lands, the body
 * grows a bridge from the context this seam already carries.
 */
export function registerSidekicksPage(registry: SettingsPageRegistry): void {
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
    render: () => createElement(SidekickDefinitionsPage),
  });
}
