// The Agents pane's binding column: the roster and one card per agent. It is its own component
// because its hooks need models, which need a bridge and session store an address may not name.

import { useCallback, useMemo } from "react";

import { AgentBindingCard } from "./AgentBindingCard.js";
import { ToolAllowlistCeiling } from "./ToolAllowlistCeiling.js";
import { type AgentsPaneModels } from "../agents-pane-models.js";
import { usePushDrivenRead } from "@renderer/store/reads/hooks/usePushDrivenRead.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { RefusalCard } from "@renderer/components/Refusal/RefusalCard.js";

/** What the binding column reads from: the session's models and the agent it is about. */
export interface AgentBindingColumnProps {
  readonly models: AgentsPaneModels;
  /** The agent this console is about. `undefined` shows the whole roster. */
  readonly agentId: string | undefined;
}

/** The session's roster as one card per agent, or the one agent the console is about. */
export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { models, agentId } = props;
  const rosterState = usePushDrivenRead(models.roster);

  // The roster's own re-open: a refused subscribe is terminal, so without this the column shows
  // one line of error for as long as it stays open.
  const reopenRoster = useCallback(() => {
    // One call: `refresh` takes the subscription first where not held, then requests the read.
    models.roster.refresh("user-request");
  }, [models]);

  const agents = rosterState.kind === "loaded" ? rosterState.value.agents : [];
  const shownAgents = useMemo(
    () => (agentId === undefined ? agents : agents.filter((row) => row.agentId === agentId)),
    [agents, agentId],
  );

  return (
    <>
      {rosterState.kind === "not-loaded" ? (
        <Nothing kind="not-loaded" title="Reading this session's agents" />
      ) : null}
      {rosterState.kind === "failed" ? (
        <RefusalCard
          {...rosterState.refusal}
          action={
            <button type="button" onClick={reopenRoster}>
              Try again
            </button>
          }
        />
      ) : null}

      {/* Once for the roster: the ceiling is a node-wide fact, and an empty roster has no grant
          it qualifies. */}
      {shownAgents.length === 0 ? null : <ToolAllowlistCeiling />}

      {shownAgents.map((agent) => (
        <AgentBindingCard key={agent.agentId} agent={agent} />
      ))}
    </>
  );
}
