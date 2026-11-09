// The Agents pane body as the registry loads it. Loader-backed, so the cards and their sheets
// stay off the initial import graph.

import { createElement } from "react";

import { AgentsPane } from "./AgentsPane.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { paneBodyForKind } from "#renderer/registries/panes/body-for-kind.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { readChildRunLinks } from "#renderer/services/daemon/child-run-links.js";
import type { AgentsPaneCalls } from "../reads.js";

/**
 * The Agents pane body over the given reads, wearing the shared pane chrome at an address the pane
 * layout resolved. The chrome gets the session, agent reference and hue off the address. It gets
 * no `actions` (this kind has no head control) and no host controls: the pane layout supplies those
 * through context.
 *
 * `children` is a prop, not `createElement`'s third argument: the chrome declares it required
 * and the variadic overload does not satisfy that.
 */
function agentsPaneBody(calls: AgentsPaneCalls): (context: PaneContext) => React.ReactNode {
  return paneBodyForKind("agents", (context) =>
    createElement(PaneFrame, {
      kind: "agents",
      sessionId: context.sessionStore?.sessionId,
      entity: context.entity,
      children: createElement(AgentsPane, {
        agentId: context.entity?.id,
        bridge: context.bridge,
        sessionStore: context.sessionStore,
        calls,
      }),
    }),
  );
}

/** The daemon's reads behind the pane, one object so the models are built once per session. */
const AGENTS_PANE_CALLS: AgentsPaneCalls = { readChildRunLinks };

/** The pane body the registry loads: the chrome over the daemon's reads. */
export const Body: (context: PaneContext) => React.ReactNode = agentsPaneBody(AGENTS_PANE_CALLS);
