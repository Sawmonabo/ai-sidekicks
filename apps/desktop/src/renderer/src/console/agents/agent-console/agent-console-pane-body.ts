// The agent console's DECK body, as the registry loads it.
//
// A LOADER-BACKED BODY, so the machines column, the cards, and the two forms that move
// a binding are not on the initial import graph. The pane opens from the sidebar's
// agents section; nothing paints it before a person asks for one.
//
// ONLY THE DECK MOUNT IS BEHIND THIS BOUNDARY. `agent-console-mounts.ts` also claims a
// surface slot for the auxiliary window, and that one stays static: a window opened at
// the agent-console route has this body as its FIRST paint, so a loader there would put
// a fallback frame in front of the only thing that window exists to show, while saving
// bytes on an entry graph that window loads anyway.

import { createElement } from "react";

import { AgentConsoleBody } from "./AgentConsoleBody.js";
import { ConsolePaneChrome, paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";

/**
 * The agent console, wearing the console's chrome, at an address the deck resolved.
 *
 * THE CHROME IS COMPOSED HERE RATHER THAN INSIDE THE BODY, because the body is also the
 * window's and the window draws its own frame. Everything the chrome is handed is read
 * off the pane's address: the session the pane's store is open on, the agent reference
 * the address carries, and the hue the deck attributed the pane with. It is handed no
 * `actions` — this kind has no head control of its own today, and an empty strip is what
 * that honestly renders as — and neither host control, because closing a pane and
 * tearing one off are the DECK's acts and reach the chrome through the context the deck
 * provides around every pane it lays out.
 *
 * `children` is passed as a PROP rather than as `createElement`'s third argument: the
 * chrome declares it required, and the variadic overload does not satisfy a required
 * `children` — it type-checks the props object on its own.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "agent-console",
  (context) =>
    createElement(ConsolePaneChrome, {
      kind: "agent-console",
      sessionId: context.sessionStore?.sessionId,
      entity: context.entity,
      focusHue: context.focusHue,
      children: createElement(AgentConsoleBody, {
        sessionId: context.sessionStore?.sessionId,
        agentId: context.entity?.id,
        bridge: context.bridge,
        sessionStore: context.sessionStore,
      }),
    }),
);
