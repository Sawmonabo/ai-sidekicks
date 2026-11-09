// The Agents pane body: what the session dispatched, and what each agent in the session is running
// under. It draws no heading of its own; the pane frame names the pane. Every prop the frame
// resolves is optional because a bare route resolves no session and an address may name no agent,
// so the binding column states which half is missing.

import "./AgentsPane.css";

import { useCallback, type ReactNode } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { useAgentsPaneModels } from "./hooks/useAgentsPaneModels.js";
import type { AgentsPaneCalls } from "../reads.js";
import type { AgentsPaneModels } from "./models.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { sessionAgentLists } from "#renderer/store/agents/list.js";
import { useSessionAgentList } from "#renderer/store/agents/hooks/useSessionAgentList.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { AgentBindingColumn } from "./components/AgentBindingColumn.js";
import { ChildRunTree } from "./components/ChildRunTree.js";

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

/** The Agents pane body: the session's columns, or the reason there is no session to read. */
export function AgentsPane(props: AgentsPaneProps): React.JSX.Element {
  const models = useAgentsPaneModels(props.bridge, props.sessionStore, props.calls);

  return (
    <div className="meridian-agents">
      <div className="meridian-agents__columns">
        {models === undefined || props.bridge === undefined ? (
          <BindingColumnFrame>
            <Nothing
              kind="not-checked"
              placement="block"
              title="This app was not handed a session to read sidekicks from."
              detail={
                "The sidekick list and the binding are scoped to one session, so " +
                "nothing was asked of the background service."
              }
            />
          </BindingColumnFrame>
        ) : (
          <SessionAgentsColumns models={models} bridge={props.bridge} agentId={props.agentId} />
        )}
      </div>
    </div>
  );
}

/** The two columns over the session's one agent list, which names the children and the cards. */
function SessionAgentsColumns(props: {
  readonly models: AgentsPaneModels;
  readonly bridge: PlatformBridge;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const feed = agentListFeedFor(props.bridge);
  const sessionId = heldIdAsWireId<SessionId>(props.models.sessionId);
  const agentListState = useSessionAgentList(feed, sessionId);
  // The agent list's own re-open: a list lost to an unreadable message stays lost until the stream
  // opens again, so without this the column shows one line of error for as long as it stays open.
  const reopenAgentList = useCallback(() => {
    sessionAgentLists.reopen(feed, sessionId);
  }, [feed, sessionId]);

  return (
    <>
      <div className="meridian-agents__column" role="group" aria-label="Dispatched sidekicks">
        <ChildRunTree models={props.models} agentListState={agentListState} />
      </div>
      <BindingColumnFrame>
        <AgentBindingColumn
          agentListState={agentListState}
          reopenAgentList={reopenAgentList}
          agentId={props.agentId}
        />
      </BindingColumnFrame>
    </>
  );
}

/** The binding column's box and heading, over whatever `children` shows under it. */
function BindingColumnFrame(props: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div className="meridian-agents__column" aria-label="Binding">
      <h3 className="meridian-agents__column-title">Binding</h3>
      {props.children}
    </div>
  );
}
