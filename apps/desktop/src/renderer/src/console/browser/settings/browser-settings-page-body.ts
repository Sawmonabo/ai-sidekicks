// The browser settings page's body, and the root of the chunk it arrives in.
//
// A LOADER-BACKED BODY, on the product question `apps/desktop/AGENTS.md` states the rule
// on: is this painted before a person acts? The page is a SETTINGS section — a person
// navigates to settings and then chooses a section, which is two acts after the first
// paint — so it takes the same form `agents/definitions/sidekick-definitions-page-body.ts`
// takes for the section beside it, and for the same measured reason: the registration in
// `console/browser-settings-page.ts` held a `render`, so the section, its policy rows, its
// partition table, and the two-step clear with its arming rounds were on the renderer's
// initial import graph of every launch, including every launch that never opens settings.
//
// WHY THIS ROOT EXISTS RATHER THAN THE REGISTRATION NAMING THE FAMILY DOOR. Nothing
// would have changed: `../index.ts` is reached eagerly by `console/panes/index.ts` for
// the browser pane's registration, so a dynamic import of it resolves to a chunk that is
// already static and defers nothing. The boundary has to name a module the eager graph
// does not reach, which is this one.
//
// TWO SHEETS ENTER HERE AND ONE OF THEM IS SHARED. `./settings.css` dresses this page's
// rows, table and switches and is reachable from nowhere else. `../controls.css` dresses
// the button and the disclosure this family's three surfaces all wear, so it is named
// from BOTH of this family's chunk roots — the shape `agents/agent-console/` already
// takes for its four — rather than left at a door whose own static graph can now render
// nothing against it, which is the state
// `test/console/architecture/stylesheet-chunk-root-ownership.test.ts` reports.
//
// Both moves are admitted by the collision census
// (`test/console/architecture/stylesheet-selector-owners.test.ts`): no other family
// declares a class either sheet declares, so deferring them changes no surface but this
// family's own — which is the condition the family door's own header already states.
//
// WHAT IT DECLARES IT NEEDS IS A BRIDGE, and that is the whole of it. `LoadedLazyBody`
// asks for a body taking the board's context — here the settings family's
// `SettingsPageContext` — and a function accepting a wider parameter satisfies one
// expecting a narrower, so naming the one member this page reads is both sufficient and
// true. Naming the settings context instead would make the browser family import a
// sibling view family's vocabulary, which `console-view-family-isolation` in
// `.dependency-cruiser.mjs` fails, and it would claim a dependency on a rail, a retained
// session and that session's store this page does not have: both of its reads are
// node-wide and it navigates nowhere.

import "./settings.css";
import "../controls.css";

import { createElement } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { BrowserSettingsSection } from "./BrowserSettingsSection.js";

/** The browser's node-wide switches and its site-data table, as the settings board loads it. */
export function Body(context: { readonly bridge: ConsoleBridge }): React.ReactNode {
  return createElement(BrowserSettingsSection, { bridge: context.bridge });
}
