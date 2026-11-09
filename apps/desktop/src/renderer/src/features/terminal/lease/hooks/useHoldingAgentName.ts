// The name of the agent whose running command holds a shell: the holding run, read off the
// session store, names its agent, and the session's agent list names that agent. Until both have
// been read there is no name, so the lease line draws nothing rather than a name it made up.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { readWireString } from "#renderer/lib/wire/strings.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { agentNameOf } from "#renderer/store/agents/list.js";
import { useSessionAgentList } from "#renderer/store/agents/hooks/useSessionAgentList.js";
import { useSessionEntity } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import type { SessionStore } from "#renderer/store/session/store.js";

/**
 * The holding run's agent's name, or `undefined` while no run holds the shell, the run has not
 * named its agent, or the agent list has not delivered that agent. The agent list is read only
 * while a run holds the shell.
 */
export function useHoldingAgentName(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  holderRunId: RunId | undefined,
): string | undefined {
  // No run has the empty id, so with no holding run this reads no entity.
  const run = useSessionEntity(sessionStore, { kind: "run", id: holderRunId ?? "" });
  const agentId = readWireString(run?.body?.["agentId"]);
  const agentList = useSessionAgentList(
    holderRunId === undefined ? undefined : agentListFeedFor(bridge),
    heldIdAsWireId<SessionId>(sessionStore.sessionId),
  );
  return agentNameOf(
    agentList,
    agentId === undefined ? undefined : heldIdAsWireId<AgentId>(agentId),
  );
}
