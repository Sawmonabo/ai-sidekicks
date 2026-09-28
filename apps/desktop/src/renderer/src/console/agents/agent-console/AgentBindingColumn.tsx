// The agent console's binding column: the roster and one card per agent.
//
// WHY THIS IS A SEPARATE COMPONENT FROM THE PANE. Every read here needs the models,
// and the models need a bridge and a session store — both of which an auxiliary
// address may legitimately fail to name. Hooks cannot be called conditionally, so the
// column that NEEDS them is its own component, mounted only where they exist, and the
// pane renders the absence when they do not.

import { useCallback, useMemo } from "react";

import { AgentCard, ToolGrantCeiling } from "../agent-card/index.js";
import { type AgentConsoleModels } from "../run-console/agent-console-model.js";
import { usePushDrivenRead } from "../../seats/index.js";
import { Nothing, RefusalCard } from "../../primitives/index.js";

/** What the binding column reads from: the session's models and the agent it is about. */
export interface AgentBindingColumnProps {
  readonly models: AgentConsoleModels;
  /** The agent this console is about. `undefined` shows the whole roster. */
  readonly agentId: string | undefined;
}

/** The session's roster as one card per agent, or the one agent the console is about. */
export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { models, agentId } = props;
  const rosterState = usePushDrivenRead(models.roster);

  // The roster read's OWN re-open. A refused subscribe is terminal — nothing re-runs
  // the effect that opened it — so without this the column says one line of error text
  // for as long as it stays open, and a cap that clears in thirty seconds is
  // indistinguishable from a refusal that never will.
  const reopenRoster = useCallback(() => {
    // ONE CALL, because the seam owns the stream-then-read order: `refresh` takes
    // the subscription first where it is not held and requests the read either way.
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

      {/* ONCE FOR THE ROSTER, NEVER PER CARD. The ceiling an allowlist cannot raise
          is a fact about this NODE, so it is stated where the roster is rather than
          repeated under every agent — and it is stated only where there is at least
          one agent to state it about, since an empty roster has no grant it qualifies. */}
      {shownAgents.length === 0 ? null : <ToolGrantCeiling />}

      {shownAgents.map((agent) => (
        <AgentCard key={agent.agentId} agent={agent} />
      ))}
    </>
  );
}
