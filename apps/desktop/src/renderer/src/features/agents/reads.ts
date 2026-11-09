// The reads behind the Agents pane: the session's agents, off the agent list every view of the
// session shares, and the child-run links, with what refreshes them. How long the links read lives
// is `pane/models.ts`'s concern. The clock is the caller's: no factory reads one of its own, so the
// scenario clock drives every debounce.

import type { AgentDefinition } from "@ai-sidekicks/contracts/agent/definition";
import type { AgentSubscribeEntry } from "@ai-sidekicks/contracts/agent/methods";
import type {
  AgentChildRunLinkListRequest,
  AgentChildRunLinkListResponse,
} from "@ai-sidekicks/contracts/orchestration";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { RUN_STATE_EVENT_TYPES } from "@ai-sidekicks/contracts/transcript/operations";
import type { Clock } from "#renderer/lib/clock.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { subscribeToSessionEventKinds } from "#renderer/store/session/events/signal.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import type { SessionAgentListState } from "#renderer/store/agents/list.js";

/**
 * The kinds that move the session's child links: every run state change (a child queued, started,
 * waiting, finished), a provider's helper starting or ending, and `agent.run.rejected`, the only
 * record of a refused create (no link row is left).
 */
const CHILD_RUN_LINK_EVENT_KINDS: readonly SessionEventType[] = [
  ...RUN_STATE_EVENT_TYPES,
  "agent.subagent.started",
  "agent.subagent.completed",
  "agent.subagent.stopped",
  "agent.run.rejected",
];

/** Names the child-run links read in a refusal. */
export const CHILD_RUN_LINKS_ORIGIN = "child-run-links";

/**
 * Reads the session's child-run tree, its counts and its refused creates over `bridge`, stopping
 * when `signal` aborts; a refusal rejects.
 */
export type ReadChildRunLinks = (
  bridge: PlatformBridge,
  request: AgentChildRunLinkListRequest,
  signal: AbortSignal,
) => Promise<AgentChildRunLinkListResponse>;

/** Lists the saved agent definitions. */
export type ListAgentDefinitions = () => Promise<readonly AgentDefinition[]>;

/** The calls the Agents pane's models drive. Held stable by the caller. */
export interface AgentsPaneCalls {
  readonly readChildRunLinks: ReadChildRunLinks;
}

/** The child-run links read. */
export type ChildRunLinksRead = PushDrivenRead<AgentChildRunLinkListResponse>;

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

/**
 * The session's child links and refusal fold, refreshed by the two kinds that move it.
 * A burst of queued children costs one read: the shared scheduler coalesces them.
 */
export function createChildRunLinks(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  clock: Clock,
  readChildRunLinks: ReadChildRunLinks,
): ChildRunLinksRead {
  return new PushDrivenRead<AgentChildRunLinkListResponse>({
    clock,
    origin: CHILD_RUN_LINKS_ORIGIN,
    read: async (signal) =>
      await readChildRunLinks(
        bridge,
        { sessionId: heldIdAsWireId(sessionStore.sessionId) },
        signal,
      ),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINK_EVENT_KINDS, onChangeSignal),
  });
}

/** What is shown before the list is served, one array so a view's memo holds. */
const NO_AGENTS: readonly AgentSubscribeEntry[] = [];
