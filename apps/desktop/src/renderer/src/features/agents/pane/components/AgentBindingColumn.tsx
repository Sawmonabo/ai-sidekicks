// The Agents pane's binding column: the agent list and one card per agent. It is its own component
// because its hooks need models, which need a bridge and session store an address may not name.

import { useCallback, useMemo } from "react";

import { AgentBindingCard } from "./AgentBindingCard.js";
import { ToolAllowlistCeiling } from "../tool-allowlist/components/ToolAllowlistCeiling.js";
import { type AgentsPaneModels } from "../models.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { RefusalCard } from "#renderer/components/Refusal/RefusalCard.js";
import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import { dayClockChangesAt } from "#renderer/lib/wire/figures.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

/** What the binding column reads from: the session's models and the agent it is about. */
export interface AgentBindingColumnProps {
  readonly models: AgentsPaneModels;
  /** The agent this console is about. `undefined` shows the whole agent list. */
  readonly agentId: string | undefined;
}

/** The session's agent list as one card per agent, or the one agent the console is about. */
export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { models, agentId } = props;
  const agentListState = usePushDrivenRead(models.agentList);

  // The agent list's own re-open: a refused subscribe is terminal, so without this the column shows
  // one line of error for as long as it stays open.
  const reopenAgentList = useCallback(() => {
    // One call: `refresh` takes the subscription first where not held, then requests the read.
    models.agentList.refresh("user-request");
  }, [models]);

  const agents = agentListState.kind === "loaded" ? agentListState.value.agents : [];
  const shownAgents = useMemo(
    () => (agentId === undefined ? agents : agents.filter((row) => row.agentId === agentId)),
    [agents, agentId],
  );
  // The cards' day words move at local midnight, so the column wakes then and at no other time.
  const nowMilliseconds = useDrawnInstant(useClock(), shownAgents, dayClockChangesAt);

  return (
    <>
      {agentListState.kind === "not-loaded" ? (
        <Nothing kind="not-loaded" title="Reading this session's sidekicks" />
      ) : null}
      {agentListState.kind === "failed" ? (
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
