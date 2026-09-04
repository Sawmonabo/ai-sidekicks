// One session's collaboration models, and who owns their lifetime.
//
// TWO SIDEBAR SECTIONS SHARE ONE SET. The channel list and the roster are filled
// independently — the sidebar renders each through its own seat — but they read
// one session's channels, one session's presence, and one set of live indicators.
// Building a set per section would put two `ActivityIndicatorRegistry` instances
// behind one session, which is the second source of truth this console does not
// permit anywhere else and would not permit here either.
//
// SO THE HOLDER IS THE OWNER, AND IT IS AN INSTANCE, NOT A SINGLETON. The family's
// registrar constructs exactly one and both section descriptors close over it. A
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
// committed section is still reading. So the holder hands out a lease, both section
// bodies take one from a mount effect through {@link useSessionModels}, and the set
// is disposed when the LAST lease is given back. Counting rather than trusting one
// caller is what makes a collapsed section and a torn-down window the same code
// path.
//
// COLLAPSING A SECTION STILL DOES NOT RELEASE THE MODELS. The sidebar keeps every
// section body mounted and tells each one whether it is open, so a collapsed section
// holds its lease and its read stays current; the two release points are the session
// switch — where the sibling's lease moves to the new session's set — and the
// window's teardown, where both leases go back at once.
//
// THE CLOCK COMES FROM THE BRIDGE, NOT FROM THE PLATFORM. Under the fixture the
// scenario's frozen clock is the only clock the renderer reads, so every deadline
// in these models advances exactly when a scenario tick says it does. Under the
// live bridge it is the real one.

import { useEffect, useState } from "react";

import type { SessionStore } from "../store/index.js";
import type { ConsoleClock } from "../core/index.js";
import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import { isCurrentSessionSubject, type SessionSubject } from "../seats/index.js";
import { ActivityIndicatorRegistry, type ChannelActivityLabels } from "./activity-model.js";
import { createChannelDirectory, type ChannelDirectory } from "./channel-model.js";
import { createPresenceRoster, type PresenceRoster } from "./presence-model.js";

/** Everything one session's collaboration surfaces read from. */
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
  readonly channelDirectory: ChannelDirectory;
  readonly presenceRoster: PresenceRoster;
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
 * Constructed by `registerCollaborationSections` and captured by both section
 * descriptors. Every model it builds is started here — subscription first, then the
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
    built.presenceRoster.start();
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
    held.presenceRoster.dispose();
    held.activity.dispose();
  }

  /**
   * One lease over one set, keyed on the set's own identity.
   *
   * The identity check is what makes a stale release harmless: React runs a section
   * body's cleanup after the sibling that switched sessions has already replaced the
   * held set, and a counter decremented by that cleanup would take the NEW session's
   * set down with it.
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
  return {
    subject: { bridge, sessionStore },
    clock,
    activity: new ActivityIndicatorRegistry(clock),
    channelDirectory: createChannelDirectory({ bridge, sessionStore, clock }),
    presenceRoster: createPresenceRoster({ bridge, sessionStore, clock }),
    labels: sessionProjectionLabels(sessionStore),
  };
}

/**
 * This session's models, from a lifecycle owner rather than from a render.
 *
 * `undefined` for exactly one frame — the one between the render that first names a
 * session and the effect that leases its models — and a section renders that frame as
 * the `not-loaded` kind of nothing, which is what `frame/session-lifecycle.ts` does
 * with the same gap for the same reason. Acquiring during render to close it is the
 * defect, not the fix: React may abandon a render pass, and an abandoned pass would
 * leave a started subscription with no cleanup to release it.
 *
 * SWITCHING BETWEEN TWO OPEN SESSIONS HAS THAT SAME FRAME, and it is the one that
 * matters: the render naming the new store commits before the effect that leases
 * its models, so the held set is still the PREVIOUS session's. That frame is now
 * rendered as absent rather than as the previous session's models — the check below
 * hands out a set only while it belongs to the subject it was asked about. Without it
 * the sections spent a committed frame drawing one session's channels and members
 * under another session's context, and a control pressed on that frame would have
 * carried the old session's channel id through the new session's seat.
 *
 * THE SUBJECT IS THE PAIR AND NOT THE SESSION ID, which is what this check used to
 * compare. A window handed a replacement bridge or a rebuilt store for the SAME
 * session passed that comparison on the first committed render after the
 * replacement, and the sections drew reads bound to the transport and the projection
 * that had just been retired. `seats/session-subject.ts` owns the predicate, shared
 * with the agents family's holder, which carried the same guard with the same defect.
 *
 * It narrows what is HANDED OUT and not what is held: the lease bookkeeping above
 * is untouched, so the mismatched frame still holds exactly the lease it took.
 *
 * Strict mode's double mount is idempotent by the lease count rather than by a guard:
 * the second cleanup takes the count to zero and disposes, and the second effect
 * builds a fresh set — so exactly one set is live once the pair has settled.
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
 * The activity fields carry ids and no names, and presence carries a participant id
 * and no name either, so this is the one place either becomes readable. It reads the
 * store's projection at call time rather than holding a copy, and falls back to the
 * wire id — which is a string an operator can act on — rather than to a blank or to
 * a composed placeholder that would read as a name nobody chose.
 */
export function sessionProjectionLabels(sessionStore: SessionStore): ChannelActivityLabels {
  return {
    participantLabel: (participantId) =>
      projectedName(sessionStore, "participant", participantId) ?? participantId,
    runLabel: (runId) => {
      // A run's own projection names its agent where the log carried one; failing
      // that the agent partition is asked under the same id, because a run keyed by
      // its agent is the shape the activity field's run id resolves through. Neither
      // is invented: both are reads, and the id survives when both come back empty.
      return (
        projectedName(sessionStore, "run", runId) ??
        projectedName(sessionStore, "agent", runId) ??
        runId
      );
    },
  };
}

/** One entity's projected display name, when the log carried one. */
function projectedName(
  sessionStore: SessionStore,
  kind: "participant" | "run" | "agent",
  id: string,
): string | undefined {
  const entity = sessionStore.snapshot().partitions[kind][id];
  const name = entity?.body?.["name"];
  return typeof name === "string" && name !== "" ? name : undefined;
}
