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
//     admitted events, filtered to the REGISTERED agent lifecycle kind. No
//     `agent.subscribe` exists on any transport, and inventing one would be a method
//     string with nothing behind it, so the signal is taken from the stream the
//     console already has.
//   • **The driver catalog has no signal at all, honestly.** Nothing on the wire
//     announces that a provider's model list moved, so the read is performed once and
//     its subscription is a stated no-op rather than a timer. A poll there would be the
//     console inventing a refresh policy for a fact it cannot observe.
//   • **Child links are per parent run**, and push-driven too. A child created later
//     and a create the daemon refused both arrive on the same session stream, so the
//     linkage takes the roster's signal filtered to its own two registered kinds
//     rather than going stale until the pane remounts.
//
// THE CLOCK IS THE CALLER'S. Under the fixture the scenario's frozen clock is the
// only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does — which is only true because no factory reaches for a
// clock of its own.

import type { Clock } from "@renderer/lib/clock.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import {
  type AgentListReading,
  type ChildRunLinkReading,
} from "@renderer/services/wire-shapes/agents.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type AgentDefinition } from "@renderer/services/wire-shapes/agent-definition.js";
import { PushDrivenRead, unwrapDaemonReply } from "@renderer/console/seats/index.js";
import { subscribeToSessionEventKinds } from "@renderer/store/session/session-event-signal.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import {
  AGENT_LIFECYCLE_EVENT_KINDS,
  CHILD_RUN_LINK_EVENT_KINDS,
  DRIVER_LIST_CAPABILITIES_METHOD,
  DRIVER_LIST_MODELS_METHOD,
} from "@renderer/services/wire-shapes/agent-vocabularies.js";
import type { DriverCatalogReading } from "./binding/driver-catalog.js";

/** Named in a refusal, so a failed read says which read failed. */
export const AGENT_LIST_ORIGIN = "agent-roster";
export const DRIVER_CATALOG_ORIGIN = "driver-catalog";
export const CHILD_RUN_LINKS_ORIGIN = "child-run-linkage";

/**
 * Lists the agents of one session.
 */
export type ListSessionAgents = (request: {
  readonly sessionId: string;
}) => Promise<AgentListReading>;

/**
 * Reads one parent run's child-run links and refused creates.
 */
export type ReadChildRunLinks = (request: {
  readonly parentRunId: string;
}) => Promise<ChildRunLinkReading>;

/**
 * Lists the saved agent definitions.
 */
export type ListAgentDefinitions = () => Promise<readonly AgentDefinition[]>;

/** The calls the Agents pane's models drive. Held stable by the caller. */
export interface AgentsPaneCalls {
  readonly listAgents: ListSessionAgents;
  readonly readChildRunLinks: ReadChildRunLinks;
}

export type AgentListRead = PushDrivenRead<AgentListReading>;
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;
export type ChildRunLinksRead = PushDrivenRead<ChildRunLinkReading>;

/** The roster read, refreshed by the three registered lifecycle events. */
export function createAgentList(
  sessionStore: SessionStore,
  clock: Clock,
  listAgents: ListSessionAgents,
): AgentListRead {
  return new PushDrivenRead<AgentListReading>({
    clock,
    origin: AGENT_LIST_ORIGIN,
    read: async () => await listAgents({ sessionId: sessionStore.sessionId }),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, AGENT_LIFECYCLE_EVENT_KINDS, onChangeSignal),
  });
}

/** Both driver catalogs, read together and never separately. */
export function createDriverCatalogRead(bridge: PlatformBridge, clock: Clock): DriverCatalogRead {
  return new PushDrivenRead<DriverCatalogReading>({
    clock,
    origin: DRIVER_CATALOG_ORIGIN,
    read: async (signal: AbortSignal) => {
      const [modelsReply, capabilitiesReply] = await Promise.all([
        callDaemon(bridge, DRIVER_LIST_MODELS_METHOD, {}, { signal }),
        callDaemon(bridge, DRIVER_LIST_CAPABILITIES_METHOD, {}, { signal }),
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
 * One parent run's links and refusal fold, refreshed by the two kinds that move it.
 *
 * A child created after this read settled and a create the daemon refused both
 * arrive on the session stream, so the linkage takes the same signal the roster does
 * with its own watched set — a console left open on a parent run shows what happened
 * to it rather than what had happened by the time it mounted. Coalescing is the
 * scheduler's, so a burst of queued children costs one read and no timer beyond the
 * one refresh chokepoint is introduced.
 */
export function createChildRunLinks(
  sessionStore: SessionStore,
  parentRunId: string,
  clock: Clock,
  readChildRunLinks: ReadChildRunLinks,
): ChildRunLinksRead {
  return new PushDrivenRead<ChildRunLinkReading>({
    clock,
    origin: CHILD_RUN_LINKS_ORIGIN,
    read: async () => await readChildRunLinks({ parentRunId }),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINK_EVENT_KINDS, onChangeSignal),
  });
}
