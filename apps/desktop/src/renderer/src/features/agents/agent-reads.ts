// The three reads behind the Agents pane, and what refreshes each one.
//
// One factory per read, and each one is a claim about a REFRESH STORY rather than
// about a lifetime — which is the seam that separates this module from
// `pane/agents-pane-models.ts`. That module owns how long a read lives, who holds it,
// and what disposes it; this one owns which method answers it and what makes it ask
// again. The two change for different reasons: a lease policy moves when a view
// changes how it mounts, and a refresh story moves when the wire grows a signal.
//
//   • **The roster is push-driven.** Its refresh signal is the session store's own
//     admitted events, filtered to the two events that settle an agent's provider
//     switch: one when it lands and one when it fails after it was accepted.
//   • **The driver catalog has no signal at all, honestly.** Nothing on the wire
//     announces that a provider's model list moved, so the read is performed once and
//     its subscription is a stated no-op rather than a timer. A poll there would be the
//     console inventing a refresh policy for a fact it cannot observe.
//   • **Child links are the session's whole tree**, and push-driven too. A child
//     created later and a create the daemon refused both arrive on the same session
//     stream, so the linkage takes the roster's signal filtered to its own two kinds
//     rather than going stale until the pane remounts.
//
// THE CLOCK IS THE CALLER'S. Under the fixture the scenario's frozen clock is the
// only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does — which is only true because no factory reaches for a
// clock of its own.

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

/**
 * The events the roster refreshes on: the two that settle an agent's provider
 * switch, one when it lands and one when it fails after it was accepted.
 */
const AGENT_ROSTER_EVENT_KINDS: readonly SessionEventType[] = [
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
];

/**
 * The two kinds that move the session's child links.
 *
 * A child run reaches the session stream as `run.queued`, and a create the daemon
 * refused reaches it as `orchestration.rejected` — the only record of refused work,
 * since a refusal leaves no link row behind.
 */
const CHILD_RUN_LINK_EVENT_KINDS: readonly SessionEventType[] = [
  "run.queued",
  "orchestration.rejected",
];

/** Named in a refusal, so a failed read says which read failed. */
export const AGENT_LIST_ORIGIN = "agent-roster";
export const DRIVER_CATALOG_ORIGIN = "driver-catalog";
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

export type AgentListRead = PushDrivenRead<AgentRoster>;
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;
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
 * Both driver catalogs, read together and never separately.
 *
 * The model catalog is read for one session, because it answers the models that
 * session can run; the capability flags are the drivers' own and take no session.
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
    // Nothing on the wire announces that a provider's catalog moved, so this read
    // is performed once and never re-armed. Returning a no-op unsubscribe states
    // that rather than hiding it behind a timer nobody asked for.
    subscribe: () => () => undefined,
  });
}

/**
 * The session's child links and refusal fold, refreshed by the two kinds that move it.
 *
 * A child created after this read settled and a create the daemon refused both
 * arrive on the session stream, so the linkage takes the same signal the roster does
 * with its own watched set — a console left open shows what happened rather than
 * what had happened by the time it mounted. Coalescing is the scheduler's, so a burst
 * of queued children costs one read and no timer beyond the one refresh chokepoint is
 * introduced.
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
