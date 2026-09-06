// The four reads behind the agent console, and what refreshes each one.
//
// One factory per read, and each one is a claim about a REFRESH STORY rather than
// about a lifetime — which is the seam that separates this module from
// `agent-console-model.ts`. That module owns how long a read lives, who holds it,
// and what disposes it; this one owns which method answers it and what makes it ask
// again. The two change for different reasons: a lease policy moves when a surface
// changes how it mounts, and a refresh story moves when the wire grows a signal.
//
//   • **The roster is push-driven.** Its refresh signal is the session store's own
//     admitted events, filtered to the three REGISTERED agent lifecycle kinds. No
//     `agent.subscribe` exists on any transport, and inventing one would be a method
//     string with nothing behind it, so the signal is taken from the stream the
//     console already has.
//   • **The driver catalog and the definition list have no signal at all, honestly.**
//     Nothing on the wire announces that a provider's model list or the node-local
//     definition registry moved, so each read is performed once and its subscription
//     is a stated no-op rather than a timer. A poll there would be the console
//     inventing a refresh policy for a fact it cannot observe.
//   • **Child links are per parent run**, and push-driven too. A child created later
//     and a create the daemon refused both arrive on the same session stream, so the
//     linkage takes the roster's signal filtered to its own two registered kinds
//     rather than going stale until the pane remounts.
//
// THE CLOCK IS THE CALLER'S. Under the fixture the scenario's frozen clock is the
// only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does — which is only true because no factory reaches for a
// clock of its own.

import type { ConsoleClock } from "../../core/index.js";
import {
  callDaemon,
  type AgentRosterReading,
  type ChildRunLinkReading,
  type ConsoleBridge,
  type SidekickDefinition,
} from "../../bridge/index.js";
import { PushDrivenRead, servedGrowthValueOrRaise, servedValueOrRaise } from "../../seats/index.js";
import { subscribeToSessionEventKinds, type SessionStore } from "../../store/index.js";
import {
  AGENT_LIFECYCLE_EVENT_KINDS,
  CHILD_RUN_LINKAGE_EVENT_KINDS,
  DRIVER_LIST_CAPABILITIES_METHOD,
  DRIVER_LIST_MODELS_METHOD,
  type SidekickDefinitionListReading,
} from "../agent-wire.js";
import type { DriverCatalogReading } from "../driver-catalog.js";

/** Named in a refusal, so a failed read says which read failed. */
export const AGENT_ROSTER_ORIGIN = "agent-roster";
export const DRIVER_CATALOG_ORIGIN = "driver-catalog";
export const CHILD_RUN_LINKAGE_ORIGIN = "child-run-linkage";
export const SIDEKICK_DEFINITION_ORIGIN = "sidekick-definitions";

export type AgentRosterRead = PushDrivenRead<AgentRosterReading>;
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;
export type ChildRunLinkageRead = PushDrivenRead<ChildRunLinkReading>;
export type SidekickDefinitionRead = PushDrivenRead<SidekickDefinitionListReading>;

/** The roster read, refreshed by the three registered lifecycle events. */
export function createAgentRoster(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  clock: ConsoleClock,
): AgentRosterRead {
  return new PushDrivenRead<AgentRosterReading>({
    clock,
    origin: AGENT_ROSTER_ORIGIN,
    read: async () =>
      servedGrowthValueOrRaise(
        await bridge.growth.agentList({ sessionId: sessionStore.sessionId }),
      ),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, AGENT_LIFECYCLE_EVENT_KINDS, onChangeSignal),
  });
}

/** Both driver catalogs, read together and never separately. */
export function createDriverCatalog(bridge: ConsoleBridge, clock: ConsoleClock): DriverCatalogRead {
  return new PushDrivenRead<DriverCatalogReading>({
    clock,
    origin: DRIVER_CATALOG_ORIGIN,
    read: async () => {
      const [modelsReply, capabilitiesReply] = await Promise.all([
        callDaemon(bridge, DRIVER_LIST_MODELS_METHOD, {}),
        callDaemon(bridge, DRIVER_LIST_CAPABILITIES_METHOD, {}),
      ]);
      return {
        models: servedValueOrRaise(modelsReply),
        capabilities: servedValueOrRaise(capabilitiesReply),
      };
    },
    // Nothing on the wire announces that a provider's catalog moved, so this read
    // is performed once and never re-armed. Returning a no-op unsubscribe states
    // that rather than hiding it behind a timer nobody asked for.
    subscribe: () => () => undefined,
  });
}

/**
 * The definition picker's read.
 *
 * No signal either: the definition registry is node-local and nothing on the session
 * stream announces an edit to it. A stale picker is refused by the daemon at attach —
 * a definition that has left the registry refuses rather than resolving to something
 * else — so the console does not need a freshness policy of its own to be correct.
 */
export function createSidekickDefinitions(
  bridge: ConsoleBridge,
  clock: ConsoleClock,
): SidekickDefinitionRead {
  return new PushDrivenRead<SidekickDefinitionListReading>({
    clock,
    origin: SIDEKICK_DEFINITION_ORIGIN,
    read: async () =>
      pickerReadingFor(servedGrowthValueOrRaise(await bridge.growth.sidekickDefinitionList({}))),
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
export function createChildRunLinkage(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  parentRunId: string,
  clock: ConsoleClock,
): ChildRunLinkageRead {
  return new PushDrivenRead<ChildRunLinkReading>({
    clock,
    origin: CHILD_RUN_LINKAGE_ORIGIN,
    read: async () =>
      servedGrowthValueOrRaise(await bridge.growth.orchestrationChildRunLinkRead({ parentRunId })),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINKAGE_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * The picker's projection of the definition registry's own rows.
 *
 * The registry answers `SidekickDefinition`, whose nullable axes are `T | null`
 * because a stored row never omits one — `null` IS how it says "inherit". The picker
 * renders absence, which is `undefined`, so the two grammars meet here in one place
 * rather than at each field a row is read through. It is a PROJECTION and not a
 * second shape for the wire: nothing is dropped, nothing is defaulted, and a row that
 * pinned nothing arrives with nothing pinned.
 */
function pickerReadingFor(
  definitions: readonly SidekickDefinition[],
): SidekickDefinitionListReading {
  return {
    definitions: definitions.map((definition) => ({
      definitionId: definition.definitionId,
      name: definition.name,
      driverName: definition.driverName,
      modelId: definition.modelId,
      providerAccountId: definition.providerAccountId ?? undefined,
      effort: definition.effort ?? undefined,
      instructions: definition.instructions,
      goal: definition.goal ?? undefined,
      toolAllowlist: definition.toolAllowlist ?? undefined,
      executionPostureMode: definition.executionPostureMode ?? undefined,
    })),
  };
}
