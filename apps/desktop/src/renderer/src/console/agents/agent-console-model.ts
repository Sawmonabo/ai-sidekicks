// Who owns the agent console's reads, and for how long.
//
// Three reads sit behind this subtree — the roster, the driver catalog, and one
// run's child links — and each has a different refresh story, which is the whole
// reason they are built here rather than in the surfaces that render them:
//
//   • **The roster is push-driven.** Its refresh signal is the session store's own
//     admitted events, filtered to the three REGISTERED agent lifecycle kinds. No
//     `agent.subscribe` exists on any transport, and inventing one would be a method
//     string with nothing behind it, so the signal is taken from the stream the
//     console already has.
//   • **The driver catalog has no signal at all, honestly.** Nothing on the wire
//     announces that a provider's model list moved, so the read is performed once
//     and its subscription is a stated no-op rather than a timer. A poll here would
//     be the console inventing a refresh policy for a fact it cannot observe.
//   • **Child links are per parent run**, so they are built on demand and cached one
//     at a time — asking for a different run disposes the previous read.
//
// A CACHE OF ONE, TWICE OVER. A console shows one session at a time and one run's
// links at a time, so both caches hold exactly one entry and switching disposes what
// they held. That is a bound stated by construction rather than a cap with a
// rationale: neither can grow.
//
// THE CLOCK COMES FROM THE BRIDGE. Under the fixture the scenario's frozen clock is
// the only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does.

import { useEffect, useState } from "react";

import { RealClock, type ConsoleClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { callDaemonMethod } from "../collaboration/wire-access.js";
import { PushDrivenRead } from "../collaboration/push-driven-read.js";
import type { SessionStore } from "../store/index.js";
import {
  AGENT_ATTACH_METHOD,
  AGENT_CONFIG_UPDATE_METHOD,
  AGENT_DETACH_METHOD,
  AGENT_LIFECYCLE_EVENT_KINDS,
  AGENT_LIST_METHOD,
  CHILD_RUN_LINK_READ_METHOD,
  DRIVER_LIST_CAPABILITIES_METHOD,
  DRIVER_LIST_MODELS_METHOD,
  SIDEKICK_DEFINITION_LIST_METHOD,
  SIDEKICK_PEER_INVOCATION_SET_METHOD,
  type AgentAttachReading,
  type AgentConfigUpdateReading,
  type AgentRosterReading,
  type ChildRunLinkReading,
  type PeerInvocationReading,
  type ProviderAxis,
  type SidekickDefinitionListReading,
} from "./agent-wire.js";
import type { AttachRequest } from "./attach-model.js";
import type { DriverCatalogReading } from "./driver-catalog.js";

/** Named in a refusal, so a failed read says which read failed. */
export const AGENT_ROSTER_ORIGIN = "agent-roster";
export const DRIVER_CATALOG_ORIGIN = "driver-catalog";
export const CHILD_RUN_LINKAGE_ORIGIN = "child-run-linkage";
export const SIDEKICK_DEFINITION_ORIGIN = "sidekick-definitions";

export type AgentRosterRead = PushDrivenRead<AgentRosterReading>;
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;
export type ChildRunLinkageRead = PushDrivenRead<ChildRunLinkReading>;
export type SidekickDefinitionRead = PushDrivenRead<SidekickDefinitionListReading>;

/**
 * One session's agent-console reads.
 *
 * A class rather than a record: it owns the linkage cache's lifetime and its
 * teardown, and `apps/desktop/AGENTS.md` puts stateful logic in a class with private
 * fields.
 */
export class AgentConsoleModels {
  public readonly sessionId: string;
  public readonly roster: AgentRosterRead;
  public readonly driverCatalog: DriverCatalogRead;
  public readonly definitions: SidekickDefinitionRead;

  readonly #bridge: ConsoleBridge;
  readonly #clock: ConsoleClock;
  #linkage: { readonly parentRunId: string; readonly read: ChildRunLinkageRead } | undefined;
  #disposed = false;

  public constructor(bridge: ConsoleBridge, sessionStore: SessionStore) {
    this.#bridge = bridge;
    this.#clock = bridge.scenarioEngine?.clock ?? new RealClock();
    this.sessionId = sessionStore.sessionId;
    this.roster = createAgentRoster(bridge, sessionStore, this.#clock);
    this.driverCatalog = createDriverCatalog(bridge, this.#clock);
    this.definitions = createSidekickDefinitions(bridge, this.#clock);
    this.roster.start();
    this.driverCatalog.start();
    this.definitions.start();
  }

  /**
   * Attach a sidekick. Zero-residue on refusal: no agent row, no partial
   * configuration, no run — which is the daemon's guarantee and the reason this
   * method neither pre-creates anything nor cleans anything up.
   */
  public attach(request: AttachRequest): Promise<AgentAttachReading> {
    return callDaemonMethod<AttachRequest, AgentAttachReading>(
      this.#bridge,
      AGENT_ATTACH_METHOD,
      request,
    );
  }

  /** Move provider axes on a running agent. Never a second run control. */
  public updateConfig(
    agentId: string,
    axes: Partial<Record<ProviderAxis, string>>,
    interruptAndSwitch: boolean,
  ): Promise<AgentConfigUpdateReading> {
    return callDaemonMethod<
      { readonly agentId: string; readonly interruptAndSwitch: boolean } & Partial<
        Record<ProviderAxis, string>
      >,
      AgentConfigUpdateReading
    >(this.#bridge, AGENT_CONFIG_UPDATE_METHOD, { agentId, interruptAndSwitch, ...axes });
  }

  /** Move an agent to `disabled`. Reversible by re-attaching. */
  public detach(agentId: string): Promise<void> {
    return callDaemonMethod<{ readonly agentId: string }, void>(this.#bridge, AGENT_DETACH_METHOD, {
      agentId,
    });
  }

  /**
   * Set the session-scoped peer-invocation grant.
   *
   * The caller renders the REPLY's `enabled`, read back from the post-append
   * projected value, rather than echoing what it asked for.
   */
  public setPeerInvocation(enabled: boolean): Promise<PeerInvocationReading> {
    return callDaemonMethod<
      { readonly sessionId: string; readonly enabled: boolean },
      PeerInvocationReading
    >(this.#bridge, SIDEKICK_PEER_INVOCATION_SET_METHOD, { sessionId: this.sessionId, enabled });
  }

  /**
   * The child-link read for one parent run, building it on first ask.
   *
   * Asking for a different run disposes the previous read, so no scheduler and no
   * subscription survives a run the console has left.
   */
  public linkageFor(parentRunId: string): ChildRunLinkageRead {
    const held = this.#linkage;
    if (held !== undefined && held.parentRunId === parentRunId) {
      return held.read;
    }
    held?.read.dispose();
    const read = createChildRunLinkage(this.#bridge, parentRunId, this.#clock);
    this.#linkage = { parentRunId, read };
    read.start();
    return read;
  }

  /** Release every read. Terminal. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.roster.dispose();
    this.driverCatalog.dispose();
    this.definitions.dispose();
    this.#linkage?.read.dispose();
    this.#linkage = undefined;
  }
}

/**
 * Hold one {@link AgentConsoleModels} for as long as this mount shows one session.
 *
 * A hook rather than a render body: the models open subscriptions and a scheduler,
 * and a body that built them would build a new set on every pass React discarded,
 * each leaving a subscription behind it. `undefined` in either argument is a real
 * state — an auxiliary address that named no session — and answers `undefined`, which
 * the surfaces render as the absence it is.
 *
 * A MODEL NEVER BELONGS TO A SESSION IT IS NOT FOR. State replaced from an effect
 * lags its own inputs by one committed frame, so a console moving directly from one
 * open session to another renders once with the previous session's models under the
 * new session's store. That frame is not merely a stale roster: the binding column
 * would dispatch `agent.attach`, `agent.configUpdate`, and `agent.detach` through the
 * session the console has LEFT while naming the agent of the one it arrived at. So
 * the held set is answered only while it matches the store it was asked about, and
 * the mismatched frame answers `undefined` — the absence every consumer already
 * renders, and the one honest thing to say about a session nothing has been read for
 * yet.
 */
export function useAgentConsoleModels(
  bridge: ConsoleBridge | undefined,
  sessionStore: SessionStore | undefined,
): AgentConsoleModels | undefined {
  const [models, setModels] = useState<AgentConsoleModels | undefined>(undefined);

  useEffect(() => {
    if (bridge === undefined || sessionStore === undefined) {
      setModels(undefined);
      return undefined;
    }
    const built = new AgentConsoleModels(bridge, sessionStore);
    setModels(built);
    return () => {
      built.dispose();
      setModels(undefined);
    };
  }, [bridge, sessionStore]);

  // Inline rather than hoisted: the collaboration family applies the same rule to
  // its own holder, and one shared guard would put a single symbol under two
  // owners for a comparison that is one expression at each site.
  return models !== undefined && models.sessionId === sessionStore?.sessionId ? models : undefined;
}

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
      callDaemonMethod<{ readonly sessionId: string }, AgentRosterReading>(
        bridge,
        AGENT_LIST_METHOD,
        { sessionId: sessionStore.sessionId },
      ),
    subscribe: (onChangeSignal) => subscribeToAgentLifecycle(sessionStore, onChangeSignal),
  });
}

/** Both driver catalogs, read together and never separately. */
export function createDriverCatalog(bridge: ConsoleBridge, clock: ConsoleClock): DriverCatalogRead {
  return new PushDrivenRead<DriverCatalogReading>({
    clock,
    origin: DRIVER_CATALOG_ORIGIN,
    read: async () => {
      const [models, capabilities] = await Promise.all([
        callDaemonMethod<Record<string, never>, DriverCatalogReading["models"]>(
          bridge,
          DRIVER_LIST_MODELS_METHOD,
          {},
        ),
        callDaemonMethod<Record<string, never>, DriverCatalogReading["capabilities"]>(
          bridge,
          DRIVER_LIST_CAPABILITIES_METHOD,
          {},
        ),
      ]);
      return { models, capabilities };
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
      callDaemonMethod<Record<string, never>, SidekickDefinitionListReading>(
        bridge,
        SIDEKICK_DEFINITION_LIST_METHOD,
        {},
      ),
    subscribe: () => () => undefined,
  });
}

/** One parent run's links and refusal fold. */
export function createChildRunLinkage(
  bridge: ConsoleBridge,
  parentRunId: string,
  clock: ConsoleClock,
): ChildRunLinkageRead {
  return new PushDrivenRead<ChildRunLinkReading>({
    clock,
    origin: CHILD_RUN_LINKAGE_ORIGIN,
    read: async () =>
      callDaemonMethod<{ readonly parentRunId: string }, ChildRunLinkReading>(
        bridge,
        CHILD_RUN_LINK_READ_METHOD,
        { parentRunId },
      ),
    // Child creations and refusals do arrive as session events, but the two kinds
    // that carry them — the child-run link row and `orchestration.rejected`'s fold —
    // reach no store partition this console projects yet, so there is no signal to
    // key on. The read is performed once and the absence of a refresh is stated
    // rather than approximated with a timer.
    subscribe: () => () => undefined,
  });
}

/**
 * Signal on every store transition that admitted an agent-lifecycle event.
 *
 * Keyed on the store's own cursor so one event is never counted twice, and scoped to
 * the three kinds so a busy run does not re-read the roster on every token. A
 * transition that admitted nothing this read cares about produces no signal at all.
 */
function subscribeToAgentLifecycle(
  sessionStore: SessionStore,
  onChangeSignal: () => void,
): () => void {
  const watched = new Set<string>(AGENT_LIFECYCLE_EVENT_KINDS);
  let lastSeenCursor = sessionStore.snapshot().cursor;
  return sessionStore.readable.subscribe((state) => {
    const previousCursor = lastSeenCursor;
    if (state.cursor <= previousCursor) {
      return;
    }
    lastSeenCursor = state.cursor;
    const admitted = state.timeline.filter((event) => event.sequence > previousCursor);
    if (admitted.some((event) => watched.has(event.kind))) {
      onChangeSignal();
    }
  });
}
