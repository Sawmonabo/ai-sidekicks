// The Agents pane's binding column: one card per agent in the session's agent list, or the one
// agent the console is about.

import { useMemo } from "react";

import { AgentBindingCard } from "./AgentBindingCard.js";
import { ToolAllowlistCeiling } from "../tool-allowlist/components/ToolAllowlistCeiling.js";
import { listAgents } from "../../reads.js";
import type { SessionAgentListState } from "#renderer/store/agents/list.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import { dayClockChangesAt } from "#renderer/lib/wire/figures.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

/** What the binding column reads from: the session's agent list and the agent it is about. */
export interface AgentBindingColumnProps {
  readonly agentListState: SessionAgentListState;
  /** Opens the agent list's stream again after it was lost. */
  readonly reopenAgentList: () => void;
  /** The agent this console is about. `undefined` shows the whole agent list. */
  readonly agentId: string | undefined;
}

/** The session's agent list as one card per agent, or the one agent the console is about. */
export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { agentListState, agentId } = props;
  const shownAgents = useMemo(() => listAgents(agentListState, agentId), [agentListState, agentId]);
  // The cards' day words move at local midnight, so the column wakes then, and with no card, never.
  const nowMilliseconds = useDrawnInstant(useClock(), shownAgents, (instant) =>
    shownAgents.length === 0 ? Number.POSITIVE_INFINITY : dayClockChangesAt(instant),
  );

  return (
    <>
      {agentListState.status === "reading" ? (
        <Nothing kind="not-loaded" title="Loading sidekicks…" />
      ) : null}
      {agentListState.status === "failed" ? (
        <Nothing
          kind="error"
          placement="block"
          title="Couldn't load sidekicks"
          action={<TryAgainButton onPress={props.reopenAgentList} />}
          attempt={agentListState.refusal}
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
