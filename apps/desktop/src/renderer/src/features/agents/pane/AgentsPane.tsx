// The Agents pane body: what each agent in the session is running under. It draws no heading of
// its own; the pane frame names the pane. Every prop the frame resolves is optional because a
// bare route resolves no session and an address may name no agent, so the column
// states which half is missing.

import type { ReactNode } from "react";

import { useAgentsPaneModels } from "./hooks/useAgentsPaneModels.js";
import type { AgentsPaneCalls } from "../agent-reads.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import { AgentBindingColumn } from "./components/AgentBindingColumn.js";

/** What the body needs to read one session's agents. */
export interface AgentsPaneProps {
  /**
   * The agent this pane is about, wire-verbatim. `undefined` is not a fault: a picked session
   * arrives with no agent named, and the column then shows the whole agent list.
   */
  readonly agentId: string | undefined;
  /** Absent where the mount could not resolve one; the column says so. */
  readonly bridge?: PlatformBridge | undefined;
  /** Absent on a bare route, which both mount contexts admit. */
  readonly sessionStore?: SessionStore | undefined;
  /** The daemon reads the models drive. Held stable by the caller. */
  readonly calls: AgentsPaneCalls;
}

/** The body's frame: the one column, its heading, and whatever `children` shows under it. */
export function AgentsPaneFrame(props: { readonly children?: ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-agents">
      <div className="meridian-agents__columns">
        <div className="meridian-agents__column" aria-label="Binding">
          <h3 className="meridian-agents__column-title">Binding</h3>
          {props.children}
        </div>
      </div>
    </div>
  );
}

/** The Agents pane body: the binding column, or the reason there is no session to read. */
export function AgentsPane(props: AgentsPaneProps): React.JSX.Element {
  const models = useAgentsPaneModels(props.bridge, props.sessionStore, props.calls);

  return (
    <AgentsPaneFrame>
      {models === undefined ? (
        <Nothing
          kind="not-checked"
          placement="block"
          title="This app was not handed a session to read sidekicks from."
          detail="The sidekick list and the binding are scoped to one session, so nothing was asked of the background service."
        />
      ) : (
        <AgentBindingColumn models={models} agentId={props.agentId} />
      )}
    </AgentsPaneFrame>
  );
}
