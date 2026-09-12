// The browser settings page's body, and the root of the chunk it arrives in.
//
// A LOADER-BACKED BODY, so the page, its policy rows, its partition table and the clear
// control's arming rounds are not on the initial import graph. The page is a SETTINGS
// section: a person navigates to settings and then chooses a section, which is two acts
// after the first paint — the registration question the package's import boundaries
// ask, answered the way the sidekicks page beside it answers it.
//
// WHY THIS ROOT EXISTS AT ALL, RATHER THAN THE SETTINGS REGISTRATION NAMING THE FAMILY
// DOOR. `agents/definitions/sidekick-definitions-page-body.ts` states the mechanism and
// this family is the second instance of it: `browser/index.ts` is imported EAGERLY by
// `console/panes/index.ts`, which calls `registerBrowserPanes` to claim the deck's
// `browser` kind — so the door is in the entry chunk by construction, and every symbol
// it re-exported travelled with it. `BrowserSettingsSection` left through that door, so
// twelve modules of a page nobody had opened sat on every launch's initial graph while
// the pane they belong beside was correctly deferred. A dynamic import of a module the
// static graph already reaches defers nothing — the bundler assigns such a module to the
// STATIC chunk — so the boundary has to name a module the eager graph does not reach,
// which is this one.
//
// THE PAGE'S TWO SHEETS ENTER HERE, and one of them enters at the pane's root as well.
// `settings/settings.css` dresses this page alone, so it has one root and this is it.
// `../controls.css` is the family's shared button and disclosure — three surfaces draw
// them, this page and the two behind the pane's chunk — so it is named at BOTH roots,
// which is what a sheet two chunks render against needs and is the shape the agents
// family's own pair of roots already takes. It lands once whichever chunk arrives first.
//
// WHAT IT DECLARES IT NEEDS IS A BRIDGE AND NOTHING ELSE. `LoadedLazyBody` asks for a
// body taking the board's context — here `SettingsPageContext` — and a function
// accepting a wider parameter satisfies one expecting a narrower, so naming the single
// member this page reads is both sufficient and true. Naming the settings context
// instead would make the browser family import the settings family's vocabulary, which
// `console-view-family-isolation` in `.dependency-cruiser.mjs` fails, and it would claim
// a dependency on a retained session and on a rail this page does not have: both of its
// reads are node-wide, and it navigates nowhere.

import "./settings.css";
import "../controls.css";

import { createElement } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { BrowserSettingsSection } from "./BrowserSettingsSection.js";

/** The browser section of settings, as the settings board loads it. */
export function Body(context: { readonly bridge: ConsoleBridge }): React.ReactNode {
  return createElement(BrowserSettingsSection, { bridge: context.bridge });
}
