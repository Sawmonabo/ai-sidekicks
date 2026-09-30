// The three reads behind the Agents pane and what refreshes each one. How long a read
// lives is `pane/agents-pane-models.ts`'s concern. The clock is the caller's: no factory
// reads one of its own, so frozen scenario time drives every debounce.

import {
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  type AgentDefinition,
  type AgentListAck,
  type AgentListRequest,
  type ChildRunLinkReadRequest,
  type ChildRunLinkReadResponse,
  type SessionEventType,
  type SessionId,
} from "@ai-sidekicks/contracts";
import type { Clock } from "@renderer/lib/clock.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { PushDrivenRead } from "@renderer/store/reads/push-driven-read.js";
import { unwrapDaemonReply } from "@renderer/services/daemon/unwrap-daemon-reply.js";
import { subscribeToSessionEventKinds } from "@renderer/store/session/session-event-signal.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { DriverCatalogReading } from "./binding/driver-catalog.js";

/** The events the roster refreshes on: a provider switch landing, or failing after acceptance. */
const AGENT_ROSTER_EVENT_KINDS: readonly SessionEventType[] = [
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
];

/**
 * The two kinds that move the session's child links: `run.queued` for a new child, and
 * `orchestration.rejected`, the only record of a refused create (no link row is left).
 */
const CHILD_RUN_LINK_EVENT_KINDS: readonly SessionEventType[] = [
  "run.queued",
  "orchestration.rejected",
];

/** Names the roster read in a refusal, so a failed read says which read failed. */
export const AGENT_LIST_ORIGIN = "agent-roster";
/** Names the driver catalog read in a refusal. */
export const DRIVER_CATALOG_ORIGIN = "driver-catalog";
/** Names the child-run links read in a refusal. */
export const CHILD_RUN_LINKS_ORIGIN = "child-run-linkage";

/** What the roster reads off `agent.list`'s acknowledgment: the session's agents. */
export type AgentRoster = Pick<AgentListAck, "agents">;

/** Lists the agents of one session. */
export type ListSessionAgents = (request: AgentListRequest) => Promise<AgentRoster>;

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

/** The roster read. */
export type AgentListRead = PushDrivenRead<AgentRoster>;
/** The driver catalog read. */
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;
/** The child-run links read. */
export type ChildRunLinksRead = PushDrivenRead<ChildRunLinkReadResponse>;

/** The roster read, refreshed by the two events that settle a provider switch. */
export function createAgentList(
  sessionStore: SessionStore,
  clock: Clock,
  listAgents: ListSessionAgents,
): AgentListRead {
  return new PushDrivenRead<AgentRoster>({
    clock,
    origin: AGENT_LIST_ORIGIN,
    read: async () => await listAgents({ sessionId: sessionStore.sessionId as SessionId }),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, AGENT_ROSTER_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * Both driver catalogs, read together. The model catalog is per session; the capability
 * flags belong to the drivers and take no session.
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
    read: async () => await readChildRunLinks({ sessionId: sessionStore.sessionId as SessionId }),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINK_EVENT_KINDS, onChangeSignal),
  });
}
