// Who owns the agent console's reads, and for how long.
//
// LIFETIME, NOT REFRESH. Which method answers each read and what makes it ask again
// is `agent-console-reads.ts`; this module owns how long a read lives, who is
// holding it, and what disposes it. The two were one file and they change for
// different reasons — a lease policy moves when a surface changes how it mounts,
// and a refresh story moves when the wire grows a signal — so a reader chasing one
// no longer has to read past the other.
//
// A CACHE OF ONE, TWICE OVER. A console shows one session at a time and one run's
// links at a time, so both caches hold exactly one entry and switching disposes what
// they held. That is a bound stated by construction rather than a cap with a
// rationale: neither can grow. The roster, the driver catalog, and the definition
// list are built once with the models and live as long as they do; one run's child
// links are built on demand and cached one at a time — asking for a different run
// disposes the previous read.
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

import { RealClock, type ConsoleClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { callDaemonMethod, isCurrentSessionSubject, type SessionSubject } from "../seats/index.js";
import type { SessionStore } from "../store/index.js";
import {
  AGENT_ATTACH_METHOD,
  AGENT_CONFIG_UPDATE_METHOD,
  AGENT_DETACH_METHOD,
  SIDEKICK_PEER_INVOCATION_SET_METHOD,
  type AgentAttachReading,
  type AgentConfigUpdateReading,
  type PeerInvocationReading,
  type ProviderAxis,
} from "./agent-wire.js";
import {
  createAgentRoster,
  createChildRunLinkage,
  createDriverCatalog,
  createSidekickDefinitions,
  type AgentRosterRead,
  type ChildRunLinkageRead,
  type DriverCatalogRead,
  type SidekickDefinitionRead,
} from "./agent-console-reads.js";
import type { AttachRequest } from "./attach-model.js";

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
  /**
   * The exact bridge and store this set was built for.
   *
   * Public because it is what {@link useAgentConsoleModels} compares at render, and
   * the store is held rather than reduced to a `sessionId` for a second reason: a
   * child link and a refused create both arrive as session events, so the linkage
   * read needs the stream itself and not the name of the session it belongs to.
   */
  public readonly subject: SessionSubject;
  public readonly roster: AgentRosterRead;
  public readonly driverCatalog: DriverCatalogRead;
  public readonly definitions: SidekickDefinitionRead;

  readonly #clock: ConsoleClock;
  #linkage: HeldChildRunLinkage | undefined;
  #outstandingLinkageLeaseCount = 0;
  #disposed = false;

  public constructor(bridge: ConsoleBridge, sessionStore: SessionStore) {
    this.subject = { bridge, sessionStore };
    this.#clock = bridge.scenarioEngine?.clock ?? new RealClock();
    this.roster = createAgentRoster(bridge, sessionStore, this.#clock);
    this.driverCatalog = createDriverCatalog(bridge, this.#clock);
    this.definitions = createSidekickDefinitions(bridge, this.#clock);
    this.roster.start();
    this.driverCatalog.start();
    this.definitions.start();
  }

  /**
   * The session these reads answer for.
   *
   * Read off the subject rather than copied beside it: a second field holding the
   * same string is a second answer to which session this set belongs to, and the
   * one the guard consults would not be the one a caller composed a request from.
   */
  public get sessionId(): string {
    return this.subject.sessionStore.sessionId;
  }

  /**
   * Attach a sidekick. Zero-residue on refusal: no agent row, no partial
   * configuration, no run — which is the daemon's guarantee and the reason this
   * method neither pre-creates anything nor cleans anything up.
   */
  public attach(request: AttachRequest): Promise<AgentAttachReading> {
    return callDaemonMethod<AttachRequest, AgentAttachReading>(
      this.subject.bridge,
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
    >(this.subject.bridge, AGENT_CONFIG_UPDATE_METHOD, { agentId, interruptAndSwitch, ...axes });
  }

  /** Move an agent to `disabled`. Reversible by re-attaching. */
  public detach(agentId: string): Promise<void> {
    return callDaemonMethod<{ readonly agentId: string }, void>(
      this.subject.bridge,
      AGENT_DETACH_METHOD,
      {
        agentId,
      },
    );
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
    >(this.subject.bridge, SIDEKICK_PEER_INVOCATION_SET_METHOD, {
      sessionId: this.sessionId,
      enabled,
    });
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
      read: createChildRunLinkage(
        this.subject.bridge,
        this.subject.sessionStore,
        parentRunId,
        this.#clock,
      ),
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
 * A MODEL NEVER BELONGS TO A SUBJECT IT IS NOT FOR. State replaced from an effect
 * lags its own inputs by one committed frame, so a console moving directly from one
 * open session to another renders once with the previous session's models under the
 * new session's store. That frame is not merely a stale roster: the binding column
 * would dispatch `agent.attach`, `agent.configUpdate`, and `agent.detach` through the
 * session the console has LEFT while naming the agent of the one it arrived at. So
 * the held set is answered only while it matches the subject it was asked about, and
 * the mismatched frame answers `undefined` — the absence every consumer already
 * renders, and the one honest thing to say about a session nothing has been read for
 * yet.
 *
 * THE SUBJECT IS THE PAIR AND NOT THE SESSION ID, which is what this guard used to
 * compare. A replacement bridge or a rebuilt store for the SAME session passes an id
 * comparison, so the first committed render after either replacement handed back
 * models whose reads are bound to the transport and the projection that were just
 * retired — and the binding column dispatched through the superseded bridge before
 * the effect installed the replacement. `seats/session-subject.ts` owns the
 * comparison, because the collaboration family's holder had written the same guard
 * with the same defect and two copies of a predicate drift.
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

  return isCurrentSessionSubject(models?.subject, bridge, sessionStore) ? models : undefined;
}
