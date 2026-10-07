// The three reads behind the Agents pane and what refreshes each one. How long a read
// lives is `pane/models.ts`'s concern. The clock is the caller's: no factory
// reads one of its own, so the scenario clock drives every debounce.

import {
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import type { AgentDefinition } from "@ai-sidekicks/contracts/agent/definition";
import type { AgentListAck, AgentListRequest } from "@ai-sidekicks/contracts/agent/methods";
import type {
  ChildRunLinkReadRequest,
  ChildRunLinkReadResponse,
} from "@ai-sidekicks/contracts/orchestration";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { Clock } from "#renderer/lib/clock.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import { RUN_QUEUED_EVENT_KIND } from "#renderer/store/session/events/run/state-kinds.js";
import { unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import { subscribeToSessionEventKinds } from "#renderer/store/session/events/signal.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import type { DriverCatalogReading } from "#renderer/lib/provider-binding/driver-catalog.js";

/**
 * The events the agent list refreshes on: a provider switch landing, or failing after
 * acceptance.
 */
const AGENT_LIST_EVENT_KINDS: readonly SessionEventType[] = [
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
];

/**
 * The two kinds that move the session's child links: `run.queued` for a new child, and
 * `orchestration.rejected`, the only record of a refused create (no link row is left).
 */
const CHILD_RUN_LINK_EVENT_KINDS: readonly SessionEventType[] = [
  RUN_QUEUED_EVENT_KIND,
  "orchestration.rejected",
];

/** Names the agent-list read in a refusal, so a failed read says which read failed. */
export const AGENT_LIST_ORIGIN = "agent-list";
/** Names the driver catalog read in a refusal. */
export const DRIVER_CATALOG_ORIGIN = "driver-catalog";
/** Names the child-run links read in a refusal. */
export const CHILD_RUN_LINKS_ORIGIN = "child-run-links";

/** What the agent list reads off `agent.list`'s acknowledgment: the session's agents. */
export type AgentListReading = Pick<AgentListAck, "agents">;

/** Lists the agents of one session. */
export type ListSessionAgents = (request: AgentListRequest) => Promise<AgentListReading>;

/** Reads the session's child-run tree, its counts and its refused creates. */
export type ReadChildRunLinks = (
  request: ChildRunLinkReadRequest,
) => Promise<ChildRunLinkReadResponse>;

/** Lists the saved agent definitions. */
export type ListAgentDefinitions = () => Promise<readonly AgentDefinition[]>;

/** The calls the Agents pane's models drive. Held stable by the caller. */
export interface AgentsPaneCalls {
  readonly listAgents: ListSessionAgents;
  readonly readChildRunLinks: ReadChildRunLinks;
}

/** The agent-list read. */
export type AgentListRead = PushDrivenRead<AgentListReading>;
/** The driver catalog read. */
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;
/** The child-run links read. */
export type ChildRunLinksRead = PushDrivenRead<ChildRunLinkReadResponse>;

/** The agent-list read, refreshed by the two events that settle a provider switch. */
export function createAgentList(
  sessionStore: SessionStore,
  clock: Clock,
  listAgents: ListSessionAgents,
): AgentListRead {
  return new PushDrivenRead<AgentListReading>({
    clock,
    origin: AGENT_LIST_ORIGIN,
    read: async () => await listAgents({ sessionId: heldIdAsWireId(sessionStore.sessionId) }),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, AGENT_LIST_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * Both driver catalogs, read together. The model catalog is per session; the capability
 * flags belong to the drivers and take no session.
 *
 * @consumedBy the agent definition editor's provider, model and effort pickers
 */
export function createDriverCatalogRead(
  bridge: PlatformBridge,
  clock: Clock,
  sessionId: SessionId,
): DriverCatalogRead {
  return new PushDrivenRead<DriverCatalogReading>({
    clock,
    origin: DRIVER_CATALOG_ORIGIN,
    read: async (signal: AbortSignal) => {
      const [modelsReply, capabilitiesReply] = await Promise.all([
        callDaemon(bridge, "driver.listModels", { sessionId }, { signal }),
        callDaemon(bridge, "driver.listCapabilities", {}, { signal }),
      ]);
      return {
        models: unwrapDaemonReply(modelsReply),
        capabilities: unwrapDaemonReply(capabilitiesReply),
      };
    },
    // Nothing on the wire announces that a provider's catalog moved, so the read runs once
    // and never re-arms.
    subscribe: () => () => undefined,
  });
}

/**
 * The session's child links and refusal fold, refreshed by the two kinds that move it.
 * A burst of queued children costs one read: the shared scheduler coalesces them.
 */
export function createChildRunLinks(
  sessionStore: SessionStore,
  clock: Clock,
  readChildRunLinks: ReadChildRunLinks,
): ChildRunLinksRead {
  return new PushDrivenRead<ChildRunLinkReadResponse>({
    clock,
    origin: CHILD_RUN_LINKS_ORIGIN,
    read: async () =>
      await readChildRunLinks({ sessionId: heldIdAsWireId(sessionStore.sessionId) }),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINK_EVENT_KINDS, onChangeSignal),
  });
}
