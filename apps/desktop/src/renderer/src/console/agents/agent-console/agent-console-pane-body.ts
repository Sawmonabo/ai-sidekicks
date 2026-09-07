// The agent console's DECK body, as the registry loads it.
//
// A LOADER-BACKED BODY, so the machines column, the cards, and the two forms that move
// a binding are not on the initial import graph. The pane opens from the sidebar's
// agents section; nothing paints it before a person asks for one.
//
// BOTH MOUNTS ARE BEHIND A BOUNDARY. `agent-console-mounts.ts` also claims a surface
// slot for the auxiliary window, and that registration is a loader too — no main window
// routes to the slot at all, so a static one would put the whole binding surface on
// every window's initial graph to spare one window a frame.
//
// THE FAMILY'S FOUR CONSOLE SHEETS ENTER HERE AND AT THE SURFACE ROOT BESIDE THIS ONE.
// Either mount can be the first to render `AgentConsoleBody`, and neither may render it
// undressed, so both roots name the sheets and the bundler emits one shared asset for
// the pair. The fifth sheet — the sidekicks page's — stays at the family door, whose
// header states why. The move is admitted by the collision census
// (`test/console/architecture/stylesheet-selector-owners.test.ts`): no other family
// declares a class any of these four declares, so deferring them changes no surface but
// this family's own.
import "./agent-console.css";
import "../agents.css";
import "../provider-switch/provider-switch.css";
import "../run-console/run-console.css";

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
