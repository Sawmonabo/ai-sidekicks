// The browser pane's body, as the deck's registry loads it.
//
// A LOADER-BACKED BODY, so none of this pane reaches the initial import graph. The
// family door registers it as `body: () => import("./browser-pane-body.js")`, and
// the bundler splits everything this module reaches — the pane, its geometry, its
// bounds bridge, its policy rows — into a chunk that is fetched when the pane is about
// to open or on the idle warm after the first frame, whichever comes first. The rule is
// in `apps/desktop/AGENTS.md`: a pane body not on the flagship first paint registers
// through a loader.
//
// Separate from the component beside it because the two answer different questions
// and change at different times: the component is what renders, this module is the
// registry's entry point into it. Splitting them is what lets the registration terms
// below be asserted without rendering anything.
//
// A MODULE AND NOT A SUB-MODULE DOOR. It was a pane-directory barrel until the
// pane body came home to the family that owns it, and an `index.ts` here would be a
// second door inside one family: `console/browser/index.ts` would then reach a name
// it never declared through a barrel, which `console-no-barrel-chain` forbids and the
// package's module-shape rule rules out for a directory reached from outside itself.
// The family door imports this module by name instead.

// SIX OF THIS FAMILY'S SEVEN STYLESHEETS ENTER HERE, at the place those surfaces enter
// the graph at all. The door registers exactly one kind and registers it as a loader, so
// nothing on the initial graph can render the pane, its chrome, its file control, its
// cards, or its bounds table — which makes this module the way in to the code those
// rules dress, and the placement rule then puts the rules on the same edge. Imported one
// by one rather than through an `@import` chain, so every edge into this family's CSS is
// visible at one site and "imported here and nowhere else" stays checkable.
//
// AND `controls.css` IS THE SIXTH BECAUSE IT IS NAMED AT BOTH OF THIS FAMILY'S CHUNK
// ROOTS. It dresses the button and the disclosure three surfaces share — this pane's two
// and the settings page — and the settings page is now loader-backed as well, at
// `settings/browser-settings-page-body.ts`. A sheet two chunks render against is named
// at each of them and lands once, whichever chunk arrives first; naming it at only one
// would leave the other painting undressed until the first happened to arrive, which is
// the failure the package's module-shape rule names in both directions — a sheet
// deferred past a reader the initial graph carries, and a sheet held at a door no static
// reader can use.
//
// `settings/settings.css` IS THE ONE SHEET NOT HERE, because it dresses that page alone:
// its rows, its partition table and its switches have no reader in this chunk, so it
// enters at the page's own root and nowhere else.
//
// AND TWO OF THE FIVE ARE ONE SHEET SPLIT, WHICH IS THE SAME ARGUMENT ONE LEVEL DOWN.
// `pane.css` had grown to 458 lines over three directories, so it is split by WHICH
// COMPONENT DRAWS EACH ROOT: `chrome/chrome.css` for the tab strip, the load hairline,
// the page picker, and the overflow disclosure; `file/file.css` for the local file
// control and its admitted roots. `handback/` gets no sheet — the one class it draws is
// a modifier of a root two directories draw, which belongs to neither.
//
// THOSE TWO ENTER HERE AND NOT LOWER, which is the ownership rule rather than a
// shortcut: neither `chrome/` nor `file/` carries an `index.ts`, so each sheet enters
// at the door of the directory that owns it — and the directory that owns those two is
// the chunk this module roots. The order below is the order the door had them in, so
// the split changes no cascade.
import "../cards/cards.css";
import "./pane.css";
import "./chrome/chrome.css";
import "./file/file.css";
import "../bounds/bounds.css";
import "../controls.css";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { BrowserPane } from "./BrowserPane.js";

/**
 * The browser pane, as the deck holds it.
 *
 * Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader
 * module publishes: the registry composes one specifier shape, and a body module is
 * recognisable as one by reading its exports rather than by where it sits.
 *
 * IT ADVERTISES NO DETACH, because a descriptor cannot. Whether this kind may be
 * torn off into a window of its own is `seats/pane/pane-kinds.ts`'s
 * `isDetachablePaneKind`, derived from the window model's own route set — one
 * answer for the whole deck rather than a boolean each family sets for the kind it
 * owns. The answer for `browser` is no, and the reason is a property of the kind:
 * the pane's eventual body is a main-process view hosted in the window that owns
 * the pane, and following a detach would mean moving that host view between two
 * windows, for which the console ships no mechanism.
 *
 * `render` goes through `paneBodyForKind` rather than naming the component directly.
 * The registry holds one `render` per kind over the whole address union, and this body
 * is a view of the `browser` arm alone: the two untyped boundaries — a restored layout
 * row and a typed route — are where an address of another kind arrives without the
 * compiler, and mounting a browser body at one would draw a pane headed "Browser" over
 * something else entirely. The adapter narrows once and renders the kind-mismatch
 * refusal for the arm it cannot serve, which is the console's answer everywhere else:
 * one bad row loses that row rather than the deck.
 *
 * The body still takes the context whole beneath it — it needs the pane id the browser
 * wire is keyed by, the bridge it dispatches through, the session whose shell frames
 * the trail, and the focus hue rule 2 attributes the pane with — so no argument is
 * rebuilt here.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "browser",
  BrowserPane,
);
