// The roster read the console performs for a view it does not own, and the second
// reader of that same read.
//
// `runtime-node-attach/NodeRoster.tsx` is a pre-console view the console absorbs by
// import and never edits. It renders five of the wire entry's nine members and neither
// of the two a settings page needs: the capability map each node declares about itself,
// and the client version the floor verdict is computed from. It also renders nothing at
// all for an empty roster — an empty `<ul>` where "no machine is attached" belongs — and
// renders its refusals as `name: message` text rather than through the console's own
// refusal shapes.
//
// A CONSOLE SURFACE THAT WANTED ANY OF THAT HAD TWO OPTIONS, AND BOTH ARE WRONG. Editing
// the shipped subtree is forbidden: it is another plan's, and the console absorbs it
// whole precisely so its tripwires stay intact. Reading `runtimenode.roster` a second
// time is worse — two reads can disagree, and a person looking at a roster and a
// capability list built from different answers has no way to tell which is current.
//
// THIS IS THE THIRD OPTION, AND IT COSTS NO SECOND READ. The read seam that view is
// mounted with is the CONSOLE's — this module builds it — so every response is already
// passing through console code on its way in. It is recorded here as it passes, and a
// console surface renders from what the roster itself read.
//
// SPLIT OUT OF `seats/surface/absorbed-surfaces.ts`, WHICH IS WHERE THE SEAM WAS WRITTEN. That module
// decides which shipped component is mounted and under which guard; this one owns the
// seam's identity, its lifetime, and what it remembers. Different subjects, and the file
// was already the family's longest. What a burst of re-read reasons COSTS is
// `node-roster-refresh.ts` and which signals become reasons at all is
// `node-roster-triggers.ts`, both split out for the same reason.

import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeNodeRosterResponse, SessionId } from "@ai-sidekicks/contracts";

import { consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import { ConsoleRefusalError, type ConsoleRefusal } from "../../core/index.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
  type RefreshReason,
} from "../../store/index.js";
import { NodeRosterRefresh } from "./node-roster-refresh.js";
import type { NodeRosterReads } from "../../../runtime-node-attach/index.js";

/**
 * What the console knows about the roster read the absorbed view performed.
 *
 * THREE ARMS AND NOT TWO. `unread` is the window before that view's own effect has
 * fired, and it is deliberately distinguishable from a response carrying no nodes:
 * saying "no machine is attached" while the read is still in flight is a false
 * statement, and it is the one this arm exists to prevent.
 */
export type NodeRosterObservation =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly response: RuntimeNodeRosterResponse }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

/** The opening arm, shared by every session that has not been read. */
const UNREAD: NodeRosterObservation = { kind: "unread" };

/**
 * One bridge's read seam, and what the last read through it answered.
 *
 * A class with private fields rather than module-level maps, on the family's standing
 * rule — module scope is window scope here, and an auxiliary window is its own renderer
 * process with its own module graph.
 *
 * KEYED BY SESSION AS WELL AS BY BRIDGE. The view is mounted for one session at a time
 * and a settings address can move between them, so an observation held per bridge alone
 * would answer a new session's question out of the previous session's answer for exactly
 * one frame — the frame a person reads.
 *
 * WHAT BOUNDS THE MAP, since nothing evicts from it. One entry per session whose roster
 * this window has actually read, each a reference to a reply the absorbed view is
 * holding anyway, and the whole map goes when its bridge does. Eviction on the last
 * unsubscribe was the obvious bound and is wrong: that view keeps its own rows across an
 * unmount and re-mount of the same (seam, session) pair, so dropping the observation
 * there would put a re-mounted roster's rows beside a block that says nothing has been
 * read — two surfaces disagreeing, which is the one thing this module exists to prevent.
 */
class NodeRosterSeam {
  readonly #reads: NodeRosterReads;
  readonly #watchers = new Set<() => void>();
  /**
   * The single arbiter of which answer the observation is allowed to be.
   *
   * ONE GUARD, ONE HOME, and this is the home. The wrapper below used to record every
   * completion the moment it arrived, while `useNodeRosterRead` applied its own
   * request-sequence guard only after `readRoster` RETURNED — so two overlapping reads
   * settling out of order left the older reply rejected by the roster and recorded by
   * this seam, and the capability and control-holder blocks then disagreed with the
   * rows beside them. The claim is taken at DISPATCH, in the same call the view's own
   * counter is incremented by, and the record runs inside `settle`, so both admit
   * exactly the newest-issued read for a session and neither can admit one the other
   * refuses.
   *
   * Keyed by session under `#reads` as the subject, which is the pair the absorbed view
   * scopes its own held state by — the same addressing, stated once.
   */
  readonly #readGenerations = new GenerationLatch();
  // One per session with a mounted roster: what raises that view's own change signal,
  // and the scheduler that decides what a burst of reasons costs. A session with no
  // mounted roster has no entry, and a refresh requested for it does nothing rather
  // than opening a read nobody is rendering.
  readonly #refreshBySession = new Map<string, NodeRosterRefresh>();
  readonly #bridge: ConsoleBridge;
  #observationsBySession: ReadonlyMap<string, NodeRosterObservation> = new Map();

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#reads = {
      // BOTH ARMS CONVERT A RETURNED REFUSAL INTO A THROWN ONE, and the conversion is
      // the whole adapter. The bridge answers outcomes because a surface that renders a
      // refusal wants a value; the absorbed view renders its refusal from an error arm,
      // which is reached by a rejection. `ConsoleRefusalError` is the console's one
      // shape for a refusal travelling as an exception, so the code, the sentence and
      // the origin all survive the trip.
      readRoster: async (request) => {
        // Claimed HERE, before the call, because the view's own sequence counter is
        // incremented here too — this wrapper IS the call it makes. Newest-issued wins
        // on both sides, from one ordering.
        const readGeneration = this.#readGenerations.supersedeAndClaim(
          this.#reads,
          request.sessionId,
        );
        try {
          const outcome = await this.#bridge.runtimeNodeRosterRead(request);
          if (outcome.status === "refused") {
            this.#settleObservation(readGeneration, request.sessionId, {
              kind: "unreadable",
              refusal: outcome,
            });
            throw new ConsoleRefusalError(outcome);
          }
          this.#settleObservation(readGeneration, request.sessionId, {
            kind: "read",
            response: outcome.value,
          });
          return outcome.value;
        } finally {
          // Total and guarded: it frees nothing once a later read has taken the key,
          // and it covers the arm where the transport itself rejected rather than
          // answering a refusal, which would otherwise leave one held key per session.
          readGeneration.release();
        }
      },
      // The SUBSCRIBE arm throws for a second reason beyond symmetry. Handing back a
      // no-op unsubscribe would leave the roster believing it is live: it would never
      // re-read and would go quietly stale, which is the one failure a live roster
      // exists to prevent. The view's own subscribe arm catches a synchronous throw,
      // renders it, and deliberately skips the initial read rather than painting a
      // snapshot with no channel behind it.
      subscribePresence: (sessionId, onPresenceChange) => {
        // Minted BEFORE the subscribe, so a seam that signals synchronously from
        // inside its own subscribe has somewhere to land.
        const refresh = this.#refreshFor(sessionId);
        const subscription = this.#bridge.runtimeNodePresenceSubscribe(sessionId, () => {
          refresh.request("terminal-event");
        });
        if (subscription.status === "refused") {
          // The refusal is the newest answer for this session, so it takes a generation
          // of its own: a read still in flight from a torn-down mount would otherwise
          // settle over it and put a `read` observation beside a view rendering the
          // refusal.
          this.#recordNewestObservation(sessionId, { kind: "unreadable", refusal: subscription });
          this.#dropRefreshWithoutReaders(sessionId);
          throw new ConsoleRefusalError(subscription);
        }
        // Held so a console surface can raise the same signal the daemon raises, and
        // released with the subscription itself — a handler outliving the mount that
        // registered it would re-read through a seam nobody is rendering.
        const releaseReader = refresh.addReader(onPresenceChange);
        return () => {
          releaseReader();
          this.#dropRefreshWithoutReaders(sessionId);
          subscription.unsubscribe();
        };
      },
    };
  }

  /** The pair the absorbed view is mounted with. One object, for this bridge's life. */
  public get reads(): NodeRosterReads {
    return this.#reads;
  }

  public observationFor(sessionId: string): NodeRosterObservation {
    return this.#observationsBySession.get(sessionId) ?? UNREAD;
  }

  /**
   * Ask the absorbed roster to read again, through the console's refresh chokepoint.
   *
   * THE ONE MECHANISM THAT RE-READS THAT VIEW WITHOUT EDITING IT. It holds its state
   * against the `(seam, session)` pair it read for and seeds a new pair at `loading`,
   * so handing it a fresh seam to force a refresh would return a live roster to its
   * loading shape — exactly the flash its own tripwire forbids. Its presence handler is
   * the seam the contract already gives for this: a push says WHEN to re-read, the view
   * re-reads through its own path, and its refresh deliberately never re-enters
   * `loading`.
   *
   * The reason travels with the request rather than being inferred at the far end, and
   * the schedule is `node-roster-refresh.ts`'s: a window focus, a reconnect, and a
   * lease frame landing together cost one read.
   */
  public requestRefresh(sessionId: string, reason: RefreshReason): void {
    this.#refreshBySession.get(sessionId)?.request(reason);
  }

  public watch(onObservationChanged: () => void): () => void {
    this.#watchers.add(onObservationChanged);
    return () => {
      this.#watchers.delete(onObservationChanged);
    };
  }

  /** The coordinator for one session, minted on the first subscription for it. */
  #refreshFor(sessionId: string): NodeRosterRefresh {
    const held = this.#refreshBySession.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    // The window's own clock — the scenario's frozen one under the fixture — resolved
    // once per seam, which is once per bridge, because that is the lifetime a clock
    // identity belongs to and the live arm mints a fresh `RealClock` per call.
    const minted = new NodeRosterRefresh(consoleClockFor(this.#bridge));
    this.#refreshBySession.set(sessionId, minted);
    return minted;
  }

  /**
   * Drop a session's coordinator once no mounted roster is left to raise.
   *
   * Terminal on the scheduler, which is why it is a drop rather than a reset: nothing
   * armed may outlive the surface that armed it, and the next subscription mints a
   * fresh one.
   */
  #dropRefreshWithoutReaders(sessionId: string): void {
    const held = this.#refreshBySession.get(sessionId);
    if (held === undefined || held.readerCount > 0) {
      return;
    }
    held.dispose();
    this.#refreshBySession.delete(sessionId);
  }

  /** Record an answer that has no read of its own, as the newest generation. */
  #recordNewestObservation(sessionId: string, observation: NodeRosterObservation): void {
    const answerGeneration = this.#readGenerations.supersedeAndClaim(this.#reads, sessionId);
    try {
      this.#settleObservation(answerGeneration, sessionId, observation);
    } finally {
      answerGeneration.release();
    }
  }

  /** Record an answer if its generation is still the one this session is on. */
  #settleObservation(
    generation: CurrentGenerationClaim,
    sessionId: string,
    observation: NodeRosterObservation,
  ): void {
    generation.settle(() => {
      this.#record(sessionId, observation);
    });
  }

  /**
   * Record what one read answered, then tell the watchers.
   *
   * The map is REPLACED rather than mutated. Every arm this holds is a frozen value and
   * the accessor above hands one out directly, so a reader comparing snapshots compares
   * arms rather than a container that answered differently while holding the same
   * identity.
   */
  #record(sessionId: string, observation: NodeRosterObservation): void {
    const replaced = new Map(this.#observationsBySession);
    replaced.set(sessionId, observation);
    this.#observationsBySession = replaced;
    for (const watcher of this.#watchers) {
      watcher();
    }
  }
}

/**
 * One seam per bridge, held for as long as that bridge is reachable.
 *
 * WHY THE IDENTITY IS THE POINT. `SidekicksBridgeProvider` replaces its resolution as
 * STATE without remounting anything below it — when the `bridge` prop or the scenario
 * changes, and again when its own engine has been disposed and a second mount must take
 * a fresh one. So "same session, different transport" is a state this console genuinely
 * reaches, and the roster's effect has to notice it. It can only notice by depending on
 * the seam, and depending on a pair rebuilt on every render would make that dependency
 * fire on renders where nothing changed. Caching by bridge gives the effect exactly one
 * signal: a different seam means a different bridge, and nothing else does — which is
 * also why nothing here ever bumps the identity to force a refresh. The absorbed view
 * seeds its own state per seam, so a bumped identity would return a live roster to its
 * loading shape, and that view's own tripwire is that a re-read never flashes loading.
 *
 * A `WeakMap` rather than a `Map` because the key is the whole lifetime: a superseded
 * bridge is unreachable the moment the provider drops it, and its seam goes with it
 * rather than accumulating one entry per scenario swap for the life of the window.
 */
class NodeRosterSeams {
  readonly #seamsByBridge = new WeakMap<ConsoleBridge, NodeRosterSeam>();

  public forBridge(bridge: ConsoleBridge): NodeRosterSeam {
    const existingSeam = this.#seamsByBridge.get(bridge);
    if (existingSeam !== undefined) {
      return existingSeam;
    }
    const seam = new NodeRosterSeam(bridge);
    this.#seamsByBridge.set(bridge, seam);
    return seam;
  }
}

/** This window's seams. Not exported: the accessors below are the way in. */
const nodeRosterSeams = new NodeRosterSeams();

/** The read pair the absorbed view is mounted with. The same object per bridge, always. */
export function nodeRosterReadsFor(bridge: ConsoleBridge): NodeRosterReads {
  return nodeRosterSeams.forBridge(bridge).reads;
}

/**
 * What the roster read answered for this session, without asking again.
 *
 * A session this window has not opened reads `unread`, which is also the arm before the
 * absorbed view's effect has fired — so a surface rendering off this one is never ahead
 * of the roster it sits beside.
 */
export function useNodeRosterObservation(
  bridge: ConsoleBridge,
  sessionId: SessionId | string | undefined,
): NodeRosterObservation {
  const seam = nodeRosterSeams.forBridge(bridge);
  const subscribe = useCallback(
    (onObservationChanged: () => void) => seam.watch(onObservationChanged),
    [seam],
  );
  const readObservation = useCallback(
    () => (sessionId === undefined ? UNREAD : seam.observationFor(sessionId)),
    [seam, sessionId],
  );
  return useSyncExternalStore(subscribe, readObservation, readObservation);
}

/**
 * Ask the seam this bridge holds to re-read one session's roster.
 *
 * The one way in from above. `node-roster-triggers.ts` decides WHICH signals owe this
 * roster a read and reaches the schedule through here, so the seam registry stays
 * private and the edge between the two modules runs one way.
 */
export function requestNodeRosterRefresh(
  bridge: ConsoleBridge,
  sessionId: string,
  reason: RefreshReason,
): void {
  nodeRosterSeams.forBridge(bridge).requestRefresh(sessionId, reason);
}
