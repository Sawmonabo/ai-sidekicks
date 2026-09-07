// The browser pane's body, as the deck's registry loads it.
//
// A LOADER-BACKED BODY, so none of this pane reaches the initial import graph. The
// family door registers it as `body: () => import("./pane/browser-pane-body.js")`, and
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
// it never declared through a barrel, which `console-no-barrel-chain` forbids and
// `apps/desktop/AGENTS.md` §Module shape rules out for a directory reached from
// outside itself. The family door imports this module by name instead.

// THE FAMILY'S FIVE STYLESHEETS ENTER HERE, at the one place this family enters the
// graph at all. The door registers exactly one kind and registers it as a loader, so
// every module and every rule this family owns is reachable only across that `import()`
// — which makes this module the sheets' owner in the sense the placement rule means:
// the barrel of the thing that owns them. Imported one by one rather than through an
// `@import` chain, so every edge into this family's CSS is visible at one site and
// "imported here and nowhere else" stays checkable.
//
// TWO OF THE FIVE DRESS SURFACES NO REGISTRATION REACHES YET — `settings/` and
// `cards/` — so they are here on the family's behalf rather than this pane's. That is
// the honest placement while the family has one entrance: leaving them at the door
// would put rules for unmounted surfaces on the initial document, and a lane that wires
// those surfaces either reaches them from this chunk or brings a chunk root of its own,
// which `test/console/architecture/stylesheet-chunk-root-ownership.test.ts` checks.
import "../settings/settings.css";
import "../controls.css";
import "../cards/cards.css";
import "./pane.css";
import "../bounds/bounds.css";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { BrowserPane } from "./BrowserPane.js";

/**
 * The browser pane, as the deck holds it.
 *
 * Named `Body` because `seats/lazy-body.ts` fixes the export name a loader
 * module publishes: the registry composes one specifier shape, and a body module is
 * recognisable as one by reading its exports rather than by where it sits.
 *
 * IT ADVERTISES NO DETACH, because a descriptor cannot. Whether this kind may be
 * torn off into a window of its own is `seats/pane-kinds.ts`'s
 * `isDetachablePaneKind`, derived from the window model's own route set — one
 * answer for the whole deck rather than a boolean each family sets for the kind it
 * owns. The answer for `browser` is no, and the reason is a property of the kind:
 * the pane's eventual body is a main-process view hosted in the window that owns
 * the pane, and following a detach would mean moving that host view between two
 * windows, which `Spec-023 §Console Design (Meridian)` ships no mechanism for.
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
