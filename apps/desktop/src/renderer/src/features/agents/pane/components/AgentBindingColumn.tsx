// The Agents pane's binding column: the agent list and one card per agent. It is its own component
// because its hooks need models, which need a bridge and session store an address may not name.

import { useCallback, useMemo } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { AgentBindingCard } from "./AgentBindingCard.js";
import { ToolAllowlistCeiling } from "../tool-allowlist/components/ToolAllowlistCeiling.js";
import { type AgentsPaneModels } from "../models.js";
import { listAgents } from "../../reads.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { sessionAgentLists } from "#renderer/store/agents/list.js";
import { useSessionAgentList } from "#renderer/store/agents/hooks/useSessionAgentList.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { RefusalCard } from "#renderer/components/Refusal/RefusalCard.js";
import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import { dayClockChangesAt } from "#renderer/lib/wire/figures.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

/** What the binding column reads from: the session's models and the agent it is about. */
export interface AgentBindingColumnProps {
  readonly models: AgentsPaneModels;
  /** The bridge the session's agent list is read over. */
  readonly bridge: PlatformBridge;
  /** The agent this console is about. `undefined` shows the whole agent list. */
  readonly agentId: string | undefined;
}

/** The session's agent list as one card per agent, or the one agent the console is about. */
export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { models, bridge, agentId } = props;
  const feed = agentListFeedFor(bridge);
  const sessionId = heldIdAsWireId<SessionId>(models.sessionId);
  const agentListState = useSessionAgentList(feed, sessionId);

  // The agent list's own re-open: a list lost to an unreadable message stays lost until the stream
  // opens again, so without this the column shows one line of error for as long as it stays open.
  const reopenAgentList = useCallback(() => {
    sessionAgentLists.reopen(feed, sessionId);
  }, [feed, sessionId]);

  const shownAgents = useMemo(() => listAgents(agentListState, agentId), [agentListState, agentId]);
  // The cards' day words move at local midnight, so the column wakes then, and with no card, never.
  const nowMilliseconds = useDrawnInstant(useClock(), shownAgents, (instant) =>
    shownAgents.length === 0 ? Number.POSITIVE_INFINITY : dayClockChangesAt(instant),
  );

  return (
    <>
      {agentListState.status === "reading" ? (
        <Nothing kind="not-loaded" title="Reading this session's sidekicks" />
      ) : null}
      {agentListState.status === "failed" ? (
        <RefusalCard
          {...agentListState.refusal}
          action={<TryAgainButton onPress={reopenAgentList} />}
        />
      ) : null}

      {/* Once for the agent list: the ceiling is a node-wide fact, and an empty agent list has no
          allowlist it qualifies. */}
      {shownAgents.length === 0 ? null : <ToolAllowlistCeiling />}

      {shownAgents.map((agent) => (
        <AgentBindingCard key={agent.agentId} agent={agent} nowMilliseconds={nowMilliseconds} />
      ))}
    </>
  );
}
