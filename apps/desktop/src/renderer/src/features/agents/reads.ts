// The reads behind the Agents pane: the session's agents, off the agent list every view of the
// session shares, and the calls the pane's child-run links read makes. How long the links read
// lives is `pane/models.ts`'s concern.

import type { AgentDefinition } from "@ai-sidekicks/contracts/agent/definition";
import type { AgentSubscribeEntry } from "@ai-sidekicks/contracts/agent/methods";
import type { ReadChildRunLinks } from "#renderer/services/daemon/child-run-links.js";
import type { SessionAgentListState } from "#renderer/store/agents/list.js";

/** Lists the saved agent definitions. */
export type ListAgentDefinitions = () => Promise<readonly AgentDefinition[]>;

/** The calls the Agents pane's models drive. Held stable by the caller. */
export interface AgentsPaneCalls {
  readonly readChildRunLinks: ReadChildRunLinks;
}

/**
 * The agents the pane shows from the session's agent list: every agent, or only `agentId` where
 * the pane is about one; none until the list is served.
 */
export function listAgents(
  state: SessionAgentListState,
  agentId: string | undefined,
): readonly AgentSubscribeEntry[] {
  if (state.status !== "served") {
    return NO_AGENTS;
  }
  return agentId === undefined
    ? state.agents
    : state.agents.filter((agent) => agent.agentId === agentId);
}

/** What is shown before the list is served, one array so a view's memo holds. */
const NO_AGENTS: readonly AgentSubscribeEntry[] = [];
