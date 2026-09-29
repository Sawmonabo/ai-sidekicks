// The Agents pane's pane registration.
//
// The feature's door publishes the registrar below and `app/registrations.ts` calls it.

import { type PaneRegistry } from "@renderer/console/seats/index.js";

/** The owner string this body's claim carries, so a hot reload replaces. */
const AGENTS_PANE_OWNER = "agents";

/**
 * Claim the `agents` pane kind, and wrap its body in the console's chrome.
 *
 * THE CHROME IS COMPOSED IN THE BODY'S OWN MODULE, so the body draws no frame of its
 * own. Everything the chrome is handed is read off the pane's address: the session the
 * pane's store is open on, the agent reference the address carries, and the hue the
 * pane layout attributed the pane to. It is handed no `actions` — this kind has no head
 * control of its own today, and an empty strip is what that honestly renders as — and
 * neither host control, because closing a pane and tearing one off are the PANE LAYOUT's acts:
 * they reach the chrome through the context the pane layout provides around every pane it lays
 * out, and a control whose act nobody can perform is left out rather than drawn
 * disabled.
 *
 * Whether the kind may be torn off at all is `isDetachablePaneKind`'s single answer,
 * derived from the window model — this registration makes no claim about it, and
 * passing a handler would not have made the control appear either.
 *
 * The narrowing and the mismatch refusal are the seat's: `paneBodyForKind` hands this
 * render an address already narrowed to the arm it claims, so the entity below is an
 * agent reference or nothing rather than a member some other arm might carry, and a
 * context that arrived at the wrong door renders a named refusal instead of throwing
 * inside the pane layout.
 */
export function registerAgentsPane(registry: PaneRegistry): void {
  registry.register({
    kind: "agents",
    owner: AGENTS_PANE_OWNER,
    // A LOADER AND NOT A `render`, so the pane layout's mount of this body is not on the
    // initial import graph.
    body: () => import("../pane/agents-pane-body.js"),
  });
}
