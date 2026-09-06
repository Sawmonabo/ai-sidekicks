// The browser pane's descriptor — what the deck mounts, and on what terms.
//
// Separate from the component beside it because the two answer different questions
// and change at different times: the component is what renders, the descriptor is
// what the deck is allowed to do with it. Splitting them is what lets the
// registration terms below be asserted without rendering anything.
//
// A MODULE AND NOT A SUB-MODULE DOOR. It was a pane-directory barrel until the
// pane body came home to the family that owns it, and an `index.ts` here would be a
// second door inside one family: `console/browser/index.ts` would then reach a name
// it never declared through a barrel, which `console-no-barrel-chain` forbids and
// `apps/desktop/AGENTS.md` §Module shape rules out for a directory reached from
// outside itself. The family door imports this module by name instead.

import { paneBodyForKind, type ConsolePaneDescriptor } from "../../seats/index.js";
import { BrowserPane } from "./BrowserPane.js";

/**
 * The browser pane, as the deck holds it.
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
export const BROWSER_PANE_DESCRIPTOR: ConsolePaneDescriptor = {
  kind: "browser",
  owner: "browser",
  render: paneBodyForKind("browser", BrowserPane),
};
