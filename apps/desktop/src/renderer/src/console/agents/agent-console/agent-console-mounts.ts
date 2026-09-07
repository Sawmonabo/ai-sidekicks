// The agent console's two mounts: the deck's pane kind and the frame's surface slot.
//
// NOT A DOOR, AND THE DIRECTORY IT SITS IN HAS NONE. `console/panes/` is composition
// only — the seat board, one reserved line per family — so a pane BODY lives in the
// family that owns its vocabulary, and this body's vocabulary is the agents family's:
// the card, the two forms that move a binding, the settlement projection, the run
// linkage. The family door publishes the two registrars below, `panes/index.ts` calls
// the pane one from its own reserved line, and `collaboration-family.ts` calls the
// surface one. A door of this directory's own would be a barrel the family door
// forwards through, which `console-no-barrel-chain` fails and which would make this
// module's symbols reachable by two paths.
//
// WHY ONE FILE CLAIMS BOTH A PANE KIND AND A SURFACE SLOT
//
// They are two tables answering two questions — the deck's pane registry is keyed
// by pane kind, the frame's surface registry by route destination — and the agent
// console is in both because `Spec-023 §Console Design (Meridian)` §The surface set
// makes it one of exactly two panes that may be torn off into a window of its own.
// The tear-off is the same body at a different size, so a second component would be
// two renderings of one design drifting apart the first time either was edited.
//
// AND THE TWO MOUNTS WEAR DIFFERENT FRAMES, WHICH IS THE WHOLE REASON THE BODY IS ITS
// OWN MODULE. The deck's pane wears `seats/ConsolePaneChrome` like every other pane
// kind, so its head, its trail, its focus ring, and its two host controls are the
// console's one answer rather than this family's; the window wears its own heading,
// because an auxiliary window owns its frame, shares no store, and cannot be detached
// from itself. While one component drew both, this kind was the only detachable one
// whose deck mount never reached the chrome — so the control that opens it in a
// window had nowhere to render.
//
// This family REPLACES the shipped node roster's claim on the `agent-console` slot.
// The roster is not discarded: it is absorbed into the body's machines column,
// which is where it always belonged — it answers "which machines can this session's
// agents run on", and that is a column of an agent console rather than a window.

import type { ConsoleSurfaceRegistry } from "../../seats/index.js";
import { type ConsolePaneRegistry } from "../../seats/index.js";

/** The owner string both of this body's claims carry, so a hot reload replaces. */
const AGENT_CONSOLE_OWNER = "collaboration-agent-console";

/**
 * Claim the `agent-console` pane kind, and wrap its body in the console's chrome.
 *
 * THE CHROME IS COMPOSED HERE RATHER THAN INSIDE THE BODY, because the body is also
 * the window's and the window draws its own frame. Everything the chrome is handed is
 * read off the pane's address: the session the pane's store is open on, the agent
 * reference the address carries, and the hue the deck attributed the pane to. It is
 * handed no `actions` — this kind has no head control of its own today, and an empty
 * strip is what that honestly renders as — and neither host control, because closing a
 * pane and tearing one off are the DECK's acts: they reach the chrome through the
 * context the deck provides around every pane it lays out, and a control whose act
 * nobody can perform is left out rather than drawn disabled.
 *
 * Whether the kind may be torn off at all is `isDetachablePaneKind`'s single answer,
 * derived from the window model — this registration makes no claim about it, and
 * passing a handler would not have made the control appear either.
 *
 * The narrowing and the mismatch refusal are the seat's: `paneBodyForKind` hands this
 * render an address already narrowed to the arm it claims, so the entity below is an
 * agent reference or nothing rather than a member some other arm might carry, and a
 * context that arrived at the wrong door renders a named refusal instead of throwing
 * inside the deck.
 */
export function registerAgentConsolePane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "agent-console",
    owner: AGENT_CONSOLE_OWNER,
    // A LOADER AND NOT A `render`, so the deck's mount of this body is not on the
    // initial import graph. The SURFACE mount below is a loader for the same reason
    // read from the other side: no main window routes to it at all.
    body: () => import("./agent-console-pane-body.js"),
  });
}

/**
 * Claim the `agent-console` surface slot — the same body, under a window's heading.
 *
 * A LOADER, like the pane above it. The slot is reachable only at the auxiliary route,
 * so no main window ever mounts it, and a static registration would put the whole
 * binding surface on every window's initial import graph to spare one window a frame.
 * `agent-console-surface-body.ts` says what that window pays instead.
 */
export function registerAgentConsoleSurface(registry: ConsoleSurfaceRegistry): void {
  registry.register({
    slot: "agent-console",
    owner: AGENT_CONSOLE_OWNER,
    body: () => import("./agent-console-surface-body.js"),
  });
}
