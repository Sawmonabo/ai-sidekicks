// The agent console's deck body, as the registry loads it.
//
// A LOADER-BACKED BODY, so the cards and their sheets are not on the initial import
// graph: nothing paints the pane before a person asks for one.
import "./agents-pane.css";
import "./components/agent-binding-card.css";
import "../binding/components/axis-field.css";

import { createElement } from "react";

import { AgentsPane, AgentConsoleFrame } from "./AgentsPane.js";
import {
  ConsolePaneChrome,
  paneBodyForKind,
  type PaneContext,
  type PaneContextOf,
} from "@renderer/console/seats/index.js";
import type { AgentConsoleCalls } from "../agent-reads.js";

/** The agent console pane body over the given reads. */
export function agentConsolePaneBody(
  calls: AgentConsoleCalls,
): (context: PaneContext) => React.ReactNode {
  return paneBodyInChrome((context) =>
    createElement(AgentsPane, {
      agentId: context.entity?.id,
      bridge: context.bridge,
      sessionStore: context.sessionStore,
      calls,
    }),
  );
}

/**
 * A pane body wearing the console's chrome, at an address the deck resolved.
 *
 * THE CHROME IS COMPOSED HERE RATHER THAN INSIDE THE BODY, so the body draws no frame of
 * its own. Everything the chrome is handed is read off the pane's address: the session
 * the pane's store is open on, the agent reference the address carries, and the hue the
 * deck attributed the pane with. It is handed no `actions` — this kind has no head
 * control of its own today, and an empty strip is what that honestly renders as — and
 * neither host control, because closing a pane and tearing one off are the DECK's acts
 * and reach the chrome through the context the deck provides around every pane it lays
 * out.
 *
 * `children` is passed as a PROP rather than as `createElement`'s third argument: the
 * chrome declares it required, and the variadic overload does not satisfy a required
 * `children` — it type-checks the props object on its own.
 */
function paneBodyInChrome(
  renderBody: (context: PaneContextOf<"agent-console">) => React.ReactNode,
): (context: PaneContext) => React.ReactNode {
  return paneBodyForKind("agent-console", (context) =>
    createElement(ConsolePaneChrome, {
      kind: "agent-console",
      sessionId: context.sessionStore?.sessionId,
      entity: context.entity,
      focusHue: context.focusHue,
      children: renderBody(context),
    }),
  );
}

/** The pane body the registry loads: the chrome and the body's frame, with no reads. */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyInChrome(() =>
  createElement(AgentConsoleFrame),
);
