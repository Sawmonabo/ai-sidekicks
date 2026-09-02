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
//   • **The driver catalog and the definition list have no signal at all, honestly.**
//     Nothing on the wire announces that a provider's model list or the node-local
//     definition registry moved, so each read is performed once and its subscription
//     is a stated no-op rather than a timer. A poll there would be the console
//     inventing a refresh policy for a fact it cannot observe.
//   • **Child links are per parent run**, and push-driven too. A child created later
//     and a create the daemon refused both arrive on the same session stream, so the
//     linkage takes the roster's signal filtered to its own two registered kinds
//     rather than going stale until the pane remounts. They are built on demand and
//     cached one at a time — asking for a different run disposes the previous read.
//
// A CACHE OF ONE, TWICE OVER. A console shows one session at a time and one run's
// links at a time, so both caches hold exactly one entry and switching disposes what
// they held. That is a bound stated by construction rather than a cap with a
// rationale: neither can grow.
//
// ACQUIRING A LINKAGE READ IS NOT STARTING ONE, AND THAT SPLIT IS THE POINT. Starting
// opens a subscription and arms a scheduler, which React's render phase may abandon
// or replay — an abandoned pass would leave a live read with no committed cleanup to
// release it, and a replayed one would dispose a read the committed tree is still
// showing. So the cache hands out a LEASE, the surface takes one from a mount effect
// and starts the read there, and the read is disposed when the last lease is given
// back. `start()` is idempotent, so a second holder joining a live read starts
// nothing twice.
//
// THE CLOCK COMES FROM THE BRIDGE. Under the fixture the scenario's frozen clock is
// the only clock the renderer reads, so every debounce here advances exactly when a
// scenario tick says it does.

import { useEffect, useState } from "react";

import type { SessionEventType } from "@ai-sidekicks/contracts";

import { RealClock, type ConsoleClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { PushDrivenRead, callDaemonMethod } from "../seats/index.js";
import type { SessionStore } from "../store/index.js";
import {
  AGENT_ATTACH_METHOD,
  AGENT_CONFIG_UPDATE_METHOD,
  AGENT_DETACH_METHOD,
  AGENT_LIFECYCLE_EVENT_KINDS,
  AGENT_LIST_METHOD,
  CHILD_RUN_LINKAGE_EVENT_KINDS,
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
 * One holder's grant of a parent run's child-link read.
 *
 * A value the taker owns rather than a flag on the models, so releasing is something
 * the effect that acquired it can do without naming the run it acquired for — which
 * matters exactly when the run has since changed underneath it. The read is handed
 * over UNSTARTED: whoever takes the lease starts it from its own mount effect, and
 * `start()` is idempotent, so a second holder joining a live read starts nothing
 * twice.
 */
export interface ChildRunLinkageLease {
  readonly read: ChildRunLinkageRead;
  /**
   * Give this grant back.
   *
   * Idempotent, and terminal for this lease alone: a second call does nothing, and a
   * lease on a read the models have already replaced releases nothing, because the
   * read it named was disposed with the run it belonged to.
   */
  release: () => void;
}

/** The linkage read the models hold, with the run it answers for. */
interface HeldChildRunLinkage {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}

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
  /**
   * The store the linkage read takes its push signal from.
   *
   * Held rather than reduced to a `sessionId`: a child link and a refused create
   * both arrive as session events, so the read that answers for them needs the
   * stream itself and not the name of the session it belongs to.
   */
  readonly #sessionStore: SessionStore;
  #linkage: HeldChildRunLinkage | undefined;
  #outstandingLinkageLeaseCount = 0;
  #disposed = false;

  public constructor(bridge: ConsoleBridge, sessionStore: SessionStore) {
    this.#bridge = bridge;
    this.#clock = bridge.scenarioEngine?.clock ?? new RealClock();
    this.#sessionStore = sessionStore;
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

  /** Which run the held linkage answers for, or `undefined` while none is held. */
  public get heldLinkageParentRunId(): string | undefined {
    return this.#linkage?.parentRunId;
  }

  /** Linkage leases handed out and not given back. The lifetime assertion, counted. */
  public get outstandingLinkageLeaseCount(): number {
    return this.#outstandingLinkageLeaseCount;
  }

  /**
   * Take a lease on one parent run's child-link read, building it on the first ask.
   *
   * Asking for a different run disposes the previous read, so no scheduler and no
   * subscription survives a run the console has left. The read is NOT started here:
   * starting opens a subscription and arms a scheduler, and the surface that takes
   * the lease does both from a mount effect, where a cleanup exists to undo them.
   */
  public acquireLinkage(parentRunId: string): ChildRunLinkageLease {
    const held = this.#linkage;
    if (held !== undefined && held.parentRunId === parentRunId) {
      this.#outstandingLinkageLeaseCount += 1;
      return this.#leaseOn(held);
    }
    this.#releaseLinkage();
    const linkage: HeldChildRunLinkage = {
      parentRunId,
      read: createChildRunLinkage(this.#bridge, this.#sessionStore, parentRunId, this.#clock),
    };
    this.#linkage = linkage;
    this.#outstandingLinkageLeaseCount = 1;
    return this.#leaseOn(linkage);
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
    this.#releaseLinkage();
  }

  /**
   * One lease over one held read, keyed on that read's own identity.
   *
   * The identity check is what makes a stale release harmless: React runs a mount's
   * cleanup after the effect that re-keyed the run has already replaced the held
   * read, and a counter decremented by that cleanup would take the NEW run's read
   * down with it.
   */
  #leaseOn(linkage: HeldChildRunLinkage): ChildRunLinkageLease {
    let isReleased = false;
    return {
      read: linkage.read,
      release: () => {
        if (isReleased || this.#linkage !== linkage) {
          return;
        }
        isReleased = true;
        this.#outstandingLinkageLeaseCount -= 1;
        if (this.#outstandingLinkageLeaseCount <= 0) {
          this.#releaseLinkage();
        }
      },
    };
  }

  /** Dispose whatever linkage read is held, at most once. Safe with none. */
  #releaseLinkage(): void {
    const held = this.#linkage;
    this.#linkage = undefined;
    this.#outstandingLinkageLeaseCount = 0;
    held?.read.dispose();
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
      callDaemonMethod<{ readonly parentRunId: string }, ChildRunLinkReading>(
        bridge,
        CHILD_RUN_LINK_READ_METHOD,
        { parentRunId },
      ),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINKAGE_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * Signal on every store transition that admitted an event of one of these kinds.
 *
 * Keyed on the store's own cursor so one event is never counted twice, and scoped to
 * the caller's kinds so a busy run does not re-read on every token. A transition that
 * admitted nothing the caller cares about produces no signal at all.
 *
 * One subscriber for two reads: the roster watches the three agent-lifecycle kinds
 * and the linkage watches the two child-run kinds, and the only thing that differs
 * between them is the set. A second copy of this filter would drift from the first
 * the moment either set moved.
 */
function subscribeToSessionEventKinds(
  sessionStore: SessionStore,
  watchedKinds: readonly SessionEventType[],
  onChangeSignal: () => void,
): () => void {
  const watched = new Set<string>(watchedKinds);
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
