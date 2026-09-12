// One session's collaboration models, and who owns their lifetime.
//
// ONE SET PER SESSION, HELD APART FROM THE SECTION THAT READS IT. The channel list
// reads one session's channels and one set of live indicators, and both own a
// subscription. Building a set per mount would put two `ActivityIndicatorRegistry`
// instances behind one session, which is the second source of truth this console
// does not permit anywhere else and would not permit here either.
//
// SO THE HOLDER IS THE OWNER, AND IT IS AN INSTANCE, NOT A SINGLETON. The family's
// registrar constructs exactly one and the section descriptor closes over it. A
// module-level holder would be shared by every window that loaded this module, and
// an auxiliary window's sidebar is a different sidebar.
//
// A CACHE OF ONE, WHICH IS WHAT A SIDEBAR ACTUALLY NEEDS. A sidebar shows one
// session at a time, so asking for a different session disposes the previous set —
// its subscription released, its scheduler disposed, its clear timers cancelled —
// and builds a fresh one. That is a bound stated by construction rather than a cap
// with a rationale: the holder cannot grow past one entry.
//
// THE GRANT IS A LEASE, AND ACQUIRING ONE IS AN EFFECT AND NEVER A RENDER. Building
// a set opens subscriptions and arms schedulers, which React's render phase may
// abandon or replay — a discarded pass would leave a live subscription behind with
// no committed cleanup to release it, and a replayed one would dispose the models a
// committed section is still reading. So the holder hands out a lease, a section
// body takes one from a mount effect through {@link useSessionModels}, and the set
// is disposed when the LAST lease is given back. Counting rather than trusting one
// caller is what makes a collapsed section and a torn-down window the same code
// path.
//
// COLLAPSING A SECTION STILL DOES NOT RELEASE THE MODELS. The sidebar keeps every
// section body mounted and tells each one whether it is open, so a collapsed section
// holds its lease and its read stays current; the two release points are the session
// switch — where the lease moves to the new session's set — and the window's
// teardown, where it goes back.
//
// THE CLOCK COMES FROM THE BRIDGE, NOT FROM THE PLATFORM. Under the fixture the
// scenario's frozen clock is the only clock the renderer reads, so every deadline
// in these models advances exactly when a scenario tick says it does. Under the
// live bridge it is the real one.

import { useEffect, useState } from "react";

import type { ConsoleEntity, SessionStore } from "../store/index.js";
import { readWireString, type ConsoleClock } from "../core/index.js";
import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import { isCurrentSessionSubject, type SessionSubject } from "../seats/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "./activity-model.js";
import { createActivityFeed, type ActivityFeed } from "./activity-feed.js";
import { createChannelDirectory, type ChannelDirectory } from "./channels/channel-model.js";

/** Everything one session's collaboration surface reads from. */
export interface CollaborationSessionModels {
  /**
   * The exact bridge and store this set was built for.
   *
   * The one identity the set carries — a `sessionId` beside it would be a second
   * answer to which session these models belong to, and the guard below reads the
   * one the reads were actually opened against.
   */
  readonly subject: SessionSubject;
  readonly clock: ConsoleClock;
  readonly activity: ActivityIndicatorRegistry;
  /**
   * The one producer that fills {@link activity}.
   *
   * Held beside the registry rather than inside it because the two have different
   * jobs and different failure modes: the registry is the settled reading every
   * indicator renders from, and this is the read that keeps it current — which can
   * refuse, and whose refusal a surface may show without the registry knowing what a
   * wire is.
   */
  readonly activityFeed: ActivityFeed;
  readonly channelDirectory: ChannelDirectory;
  readonly labels: ChannelActivityLabels;
}

/**
 * One section body's grant of a session's models.
 *
 * A value the taker owns rather than a flag on the holder, so releasing is something
 * the effect that acquired it can do without naming the session it acquired for —
 * which matters exactly when the session has since changed underneath it.
 */
export interface CollaborationModelsLease {
  readonly models: CollaborationSessionModels;
  /**
   * Give this grant back.
   *
   * Idempotent, and terminal for this lease alone: a second call does nothing, and a
   * lease on a set the holder has already replaced releases nothing, because the set
   * it named was disposed with the session it belonged to.
   */
  release: () => void;
}

/**
 * The one owner of a session's collaboration models.
 *
 * Constructed by `registerCollaborationSections` and captured by the section
 * descriptor. Every model it builds is started here — subscription first, then the
 * read — so a section body never starts one, and {@link useSessionModels} is the one
 * caller, from a mount effect.
 */
export class CollaborationSessionModelHolder {
  #current: CollaborationSessionModels | undefined;
  #outstandingLeaseCount = 0;

  /** Leases handed out and not yet given back. The lifetime assertion, counted. */
  public get outstandingLeaseCount(): number {
    return this.#outstandingLeaseCount;
  }

  /** Which session the held set belongs to, or `undefined` while nothing is held. */
  public get heldSessionId(): string | undefined {
    return this.#current?.subject.sessionStore.sessionId;
  }

  /**
   * Take a lease on one session's models, building the set on the first ask.
   *
   * Switching sessions disposes the previous set before building the next, so no
   * subscription and no timer survives a session the sidebar has left. Every other
   * ask for the session already held joins that set rather than starting a rival
   * projection of one session's channels and presence.
   *
   * "Already held" is the SUBJECT and not the session id, by the same predicate the
   * hook renders through — and it has to be, or the two would disagree: a
   * replacement bridge for one session would join a set the render guard then
   * refuses to hand out, and the section would sit at `not-loaded` for as long as
   * the window lived.
   */
  public acquire(bridge: ConsoleBridge, sessionStore: SessionStore): CollaborationModelsLease {
    const existing = this.#current;
    if (existing !== undefined && isCurrentSessionSubject(existing.subject, bridge, sessionStore)) {
      this.#outstandingLeaseCount += 1;
      return this.#leaseOn(existing);
    }
    this.dispose();
    const built = buildSessionModels(bridge, sessionStore);
    built.channelDirectory.start();
    built.activityFeed.start();
    this.#current = built;
    this.#outstandingLeaseCount = 1;
    return this.#leaseOn(built);
  }

  /** Release whatever is held. Terminal for the models it disposes, not for the holder. */
  public dispose(): void {
    const held = this.#current;
    this.#current = undefined;
    this.#outstandingLeaseCount = 0;
    if (held === undefined) {
      return;
    }
    held.channelDirectory.dispose();
    // The feed before the registry it writes into: a settlement landing between the
    // two would note an indicator on a registry that had already released its timers.
    held.activityFeed.dispose();
    held.activity.dispose();
  }

  /**
   * One lease over one set, keyed on the set's own identity.
   *
   * The identity check is what makes a stale release harmless: React runs a section
   * body's cleanup after a switch has already replaced the held set, and a counter
   * decremented by that cleanup would take the NEW session's set down with it.
   */
  #leaseOn(models: CollaborationSessionModels): CollaborationModelsLease {
    let isReleased = false;
    return {
      models,
      release: () => {
        if (isReleased || this.#current !== models) {
          return;
        }
        isReleased = true;
        this.#outstandingLeaseCount -= 1;
        if (this.#outstandingLeaseCount <= 0) {
          this.dispose();
        }
      },
    };
  }
}

/**
 * This session's models, from a lifecycle owner rather than from a render.
 *
 * `undefined` for exactly one frame — the one between the render that first names a
 * session and the effect that leases its models — and a section renders that frame as
 * the `not-loaded` kind of nothing, which is what `frame/session/session-lifecycle.ts` does
 * with the same gap for the same reason. Acquiring during render to close it is the
 * defect, not the fix: React may abandon a render pass, and an abandoned pass would
 * leave a started subscription with no cleanup to release it.
 *
 * SWITCHING BETWEEN TWO OPEN SESSIONS HAS THAT SAME FRAME, and it is the one that
 * matters: the render naming the new store commits before the effect that leases
 * its models, so the held set is still the PREVIOUS session's. That frame is now
 * rendered as absent rather than as the previous session's models — the check below
 * hands out a set only while it belongs to the subject it was asked about. Without it
 * the section spent a committed frame drawing one session's channels under another
 * session's context, and a control pressed on that frame would have carried the old
 * session's channel id through the new session's seat.
 *
 * THE SUBJECT IS THE PAIR AND NOT THE SESSION ID, which is what this check used to
 * compare. A window handed a replacement bridge or a rebuilt store for the SAME
 * session passed that comparison on the first committed render after the
 * replacement, and the section drew reads bound to the transport and the projection
 * that had just been retired. `seats/session-subject.ts` owns the predicate, shared
 * with the agents family's holder, which carried the same guard with the same defect.
 *
 * It narrows what is HANDED OUT and not what is held: the lease bookkeeping above
 * is untouched, so the mismatched frame still holds exactly the lease it took.
 *
 * Strict mode's double mount is idempotent by the lease count rather than by a guard:
 * the second cleanup takes the count to zero and disposes, and the second effect
 * builds a fresh set — so exactly one set is live once it has settled.
 */
export function useSessionModels(
  holder: CollaborationSessionModelHolder,
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): CollaborationSessionModels | undefined {
  const [models, setModels] = useState<CollaborationSessionModels | undefined>(undefined);
  useEffect(() => {
    const lease = holder.acquire(bridge, sessionStore);
    setModels(lease.models);
    return () => {
      lease.release();
      setModels(undefined);
    };
  }, [holder, bridge, sessionStore]);
  return isCurrentSessionSubject(models?.subject, bridge, sessionStore) ? models : undefined;
}

/**
 * Resolve a participant and a run to words, against the session's own projection.
 *
 * The activity fields carry ids and no names, so this is the one place one becomes
 * readable. It reads the
 * store's projection at call time rather than holding a copy, and falls back to the
 * wire id — which is a string an operator can act on — rather than to a blank or to
 * a composed placeholder that would read as a name nobody chose.
 */
export function sessionProjectionLabels(sessionStore: SessionStore): ChannelActivityLabels {
  return {
    participantLabel: (participantId) =>
      projectedName(sessionStore, "participant", participantId) ?? participantId,
    // TWO READS, BECAUSE THE TWO PARTITIONS ARE KEYED BY DIFFERENT IDENTIFIERS. A run
    // entity is keyed by its run id and carries no name of its own — no registered
    // run-lifecycle payload names one, so the projector's body table cannot write one
    // — while the name a person reads is the AGENT's, keyed by the agent id that the
    // creation beat puts on the run's body. So the run's agent is resolved first and
    // that agent's projection second. Indexing the agent partition with the RUN's id
    // is the shape this replaced: it missed for every run a session ever had, and
    // missed silently, because the id it fell back to reads like a deliberate answer.
    runLabel: (runId) => {
      const agentId = readWireString(
        projectedEntity(sessionStore, "run", runId)?.body?.[RUN_AGENT_MEMBER],
      );
      if (agentId === undefined) {
        return runId;
      }
      return projectedName(sessionStore, "agent", agentId) ?? runId;
    },
  };
}

/**
 * Everything one session reads from, built and not yet started.
 *
 * Separate from the holder so construction stays a total function of its inputs and
 * the holder keeps only the lifetime question — which set is held, and by how many.
 */
function buildSessionModels(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): CollaborationSessionModels {
  const clock = consoleClockFor(bridge);
  const activity = new ActivityIndicatorRegistry(clock);
  return {
    subject: { bridge, sessionStore },
    clock,
    activity,
    activityFeed: createActivityFeed({ bridge, sessionStore, clock, registry: activity }),
    channelDirectory: createChannelDirectory({ bridge, sessionStore, clock }),
    labels: sessionProjectionLabels(sessionStore),
  };
}

/**
 * The body member a run carries its agent on, as the run projector writes it.
 *
 * Read through the console's own wire-string rule rather than through a contracts
 * narrowing, because an entity body is wire-verbatim: the projector's reader decided
 * this member arrived as a string, and nothing downstream re-narrows it.
 */
const RUN_AGENT_MEMBER = "agentId";

/** One stored entity, or `undefined` where this log carried no row for it. */
function projectedEntity(
  sessionStore: SessionStore,
  kind: "participant" | "run" | "agent",
  id: string,
): ConsoleEntity | undefined {
  return sessionStore.snapshot().partitions[kind][id];
}

/** One entity's projected display name, when the log carried one. */
function projectedName(
  sessionStore: SessionStore,
  kind: "participant" | "run" | "agent",
  id: string,
): string | undefined {
  return readWireString(projectedEntity(sessionStore, kind, id)?.body?.["name"]);
}
