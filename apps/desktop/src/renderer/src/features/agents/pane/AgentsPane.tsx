// The agent console's body: what each agent in the session is running under.
//
// THE FRAME IS NOT THIS MODULE'S, AND THAT IS WHY THIS FILE IS A BODY RATHER THAN A
// PANE. The deck mounts it inside `seats/ConsolePaneChrome`, which draws the section,
// the kind glyph, the breadcrumb trail, the control strip and the body box. This
// module draws no heading of its own: a second name inside the body would be a second
// answer to what this surface is called. The column keeps its own heading, because it
// names a part of this body rather than the body itself.
//
// EVERY PROP THE FRAME HAS TO RESOLVE IS OPTIONAL, AND THAT IS NOT LAZINESS. An auxiliary address
// resolves to a session and may name no agent; a bare route resolves to no session at
// all, and both contexts type `sessionStore` as possibly absent for exactly that
// reason. A pane that demanded them would be unmountable in the states the frame can
// actually produce, so the column states which half it is missing instead.

import type { ReactNode } from "react";

import { useAgentsPaneModels } from "./hooks/useAgentsPaneModels.js";
import type { AgentConsoleCalls } from "../agent-reads.js";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { Nothing } from "@renderer/console/primitives/index.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import { AgentBindingColumn } from "./components/AgentBindingColumn.js";

/** What the console body needs to read one session's agents. */
export interface AgentsPaneProps {
  /**
   * The agent this console is about, wire-verbatim.
   *
   * `undefined` is reachable and is not a fault: the frame's context picker resolves
   * a bare auxiliary address by choosing a SESSION, and the agent-console grammar
   * carries its agent with its session or not at all, so a picked session arrives
   * here with no agent named. The binding column answers it by showing the whole
   * roster rather than one card.
   */
  readonly agentId: string | undefined;
  /** Absent where the mount could not resolve one; the column says so. */
  readonly bridge?: ConsoleBridge | undefined;
  /** Absent on a bare route, which both mount contexts admit. */
  readonly sessionStore?: SessionStore | undefined;
  /** The daemon reads the models drive. Held stable by the caller. */
  readonly calls: AgentConsoleCalls;
}

/** The body's frame: the one column, its heading, and whatever `children` shows under it. */
export function AgentConsoleFrame(props: { readonly children?: ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-agent-console">
      <div className="meridian-agent-console__columns">
        <div className="meridian-agent-console__column" aria-label="Binding">
          <h3 className="meridian-agent-console__column-title">Binding</h3>
          {props.children}
        </div>
      </div>
    </div>
  );
}

/** The agent console body: the binding column, or the reason there is no session to read. */
export function AgentsPane(props: AgentsPaneProps): React.JSX.Element {
  const models = useAgentsPaneModels(props.bridge, props.sessionStore, props.calls);

  return (
    <AgentConsoleFrame>
      {models === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This console was not handed a session to read agents from."
          detail="The roster and the binding are scoped to one session, so nothing was asked of the daemon."
        />
      ) : (
        <AgentBindingColumn models={models} agentId={props.agentId} />
      )}
    </AgentConsoleFrame>
  );
}
