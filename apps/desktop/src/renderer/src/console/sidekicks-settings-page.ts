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
// THE AGENTS FAMILY IS REACHED AS A CHUNK ROOT, NOT THROUGH ITS DOOR
//
// This file named `./agents/index.js` and held the page component, which is what a
// cross-family import is supposed to look like — and it is exactly what put the page on
// every launch. That door is imported EAGERLY by `collaboration-family.ts` for the agent
// console's surface registration, so everything it statically reaches is in the entry
// chunk; the page and its stylesheet rode there whether or not settings was ever opened.
// Naming the door from a LOADER would have changed nothing either: a module already
// assigned to the static chunk is what a dynamic import of it resolves to.
//
// So the specifier below names a module the eager graph does not reach —
// `./agents/definitions/sidekick-definitions-page-body.js`, the page's own chunk root,
// which owns its sheet. That it is a deep path is not this file bending the door rule: a
// chunk root is not a symbol a barrel can publish, `agent-console-mounts.ts` names its two
// roots the same way from inside its own family, and `console-cross-family-deep-import` is
// scoped to importers inside a family directory — a composition site directly under
// `console/`, which this file is, is not one of them.
//
// THE SETTINGS FAMILY IS REACHED FOR EXACTLY ONE DECLARED THING: `SettingsPageRegistrar`,
// the one-method view of its registry that family declares for the page registered
// from outside it. Not the registry CLASS, which the door withholds on purpose, and
// not the section vocabulary or the descriptor shape — so nothing here can read the
// rail or unregister a sibling lane's page. The import is deep rather than through
// `settings/index.js` because that door imports THIS file to compose the page, and a
// type line back through it closes a module cycle `no-circular` fails on.

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
 * node-local rather than scoped to whichever session this window happens to hold. The
 * chunk root declares exactly that narrower parameter, which is what keeps the agents
 * family from naming the settings family's context type to satisfy this registration.
 *
 * `label` and `keywords` stay HERE rather than travelling with the body, and that is what
 * makes the loader form usable at all: the rail lists every registered section and the
 * search index ranks them before a person has opened any of them, so a page whose name
 * arrived with its chunk would be unfindable until it had already been found.
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
    body: () => import("./agents/definitions/sidekick-definitions-page-body.js"),
  });
}
