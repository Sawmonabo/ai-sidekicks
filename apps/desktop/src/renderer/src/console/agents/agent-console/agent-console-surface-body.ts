// The agent console's WINDOW body, as the surface registry loads it.
//
// A LOADER-BACKED BODY, and the reason is which window pays. This slot is reachable
// only at the `agent-console` auxiliary route, which no main window ever navigates to —
// the deck opens the pane instead — so a static registration charges the machines
// column, the two forms that move a binding, and the combobox stack they mount to every
// session that never tears the console off.
//
// WHAT THE AUXILIARY WINDOW PAYS INSTEAD is one chunk fetch off local disk, started on
// its first render, behind the route's own absence frame. That frame is the honest
// shape of the moment: the window has not drawn its body yet. The alternative — the
// entire binding surface on the initial import graph of every window — is a cost paid
// by sessions that will never open this one.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

// THE FOUR CONSOLE SHEETS ENTER HERE TOO, for the reason
// `agent-console-pane-body.ts` states: this root and that one are two independent first
// paints of one body, so each names the rules that body needs rather than one of them
// relying on the other having run.
import "./agent-console.css";
import "../agents.css";
import "../provider-switch/provider-switch.css";
import "../run-console/run-console.css";

import { createElement } from "react";

import { AgentConsoleWindow } from "./AgentConsoleWindow.js";
import { routeSessionId } from "../../routing/index.js";
import type { ConsoleSurfaceContext } from "../../seats/index.js";

/**
 * The agent console under a window's heading, at the route the window opened on.
 *
 * The window draws its own frame rather than the console's pane chrome, which is why
 * this is a different composition from the deck's body beside it and not a second
 * rendering of one: an auxiliary window owns its frame, shares no store, and cannot be
 * detached from itself.
 */
export function Body(context: ConsoleSurfaceContext): React.ReactNode {
  return createElement(AgentConsoleWindow, {
    sessionId: routeSessionId(context.route),
    agentId:
      context.route.kind === "auxiliary" && "agentId" in context.route
        ? context.route.agentId
        : undefined,
    bridge: context.bridge,
    sessionStore: context.sessionStore,
  });
}
