// The roster read the console performs for a view it does not own, and the second
// reader of that same read.
//
// `runtime-node-attach/NodeRoster.tsx` is a shipped Tier-1 view the console absorbs by
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
// SPLIT OUT OF `absorbed-surfaces.ts`, WHICH IS WHERE THE SEAM WAS WRITTEN. That module
// decides which shipped component is mounted and under which guard; this one owns the
// seam's identity, its lifetime, and what it remembers. Different subjects, and the file
// was already the family's longest.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { RuntimeNodeRosterResponse, SessionId } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../bridge/index.js";
import { ConsoleRefusalError, type ConsoleRefusal } from "../core/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "../store/index.js";
import type { NodeRosterReads } from "../../runtime-node-attach/index.js";

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
  // The change handlers the absorbed view registered, per session. See
  // {@link NodeRosterSeam.requestReRead} for what they are used for beyond the daemon's
  // own pushes; a session with no mounted roster has no entry, and a re-read requested
  // for it does nothing rather than opening a read nobody is rendering.
  readonly #presenceHandlersBySession = new Map<string, Set<() => void>>();
  #observationsBySession: ReadonlyMap<string, NodeRosterObservation> = new Map();

  public constructor(bridge: ConsoleBridge) {
    this.#reads = {
      // BOTH ARMS CONVERT A RETURNED REFUSAL INTO A THROWN ONE, and the conversion is
      // the whole adapter. The bridge answers outcomes because a surface that renders a
      // refusal wants a value; the absorbed view renders its refusal from an error arm,
      // which is reached by a rejection. `ConsoleRefusalError` is the console's one
      // shape for a refusal travelling as an exception, so the code, the sentence and
      // the origin all survive the trip.
      readRoster: async (request) => {
        const outcome = await bridge.runtimeNodeRosterRead(request);
        if (outcome.status === "refused") {
          this.#record(request.sessionId, { kind: "unreadable", refusal: outcome });
          throw new ConsoleRefusalError(outcome);
        }
        this.#record(request.sessionId, { kind: "read", response: outcome.value });
        return outcome.value;
      },
      // The SUBSCRIBE arm throws for a second reason beyond symmetry. Handing back a
      // no-op unsubscribe would leave the roster believing it is live: it would never
      // re-read and would go quietly stale, which is the one failure a live roster
      // exists to prevent. The view's own subscribe arm catches a synchronous throw,
      // renders it, and deliberately skips the initial read rather than painting a
      // snapshot with no channel behind it.
      subscribePresence: (sessionId, onPresenceChange) => {
        const subscription = bridge.runtimeNodePresenceSubscribe(sessionId, onPresenceChange);
        if (subscription.status === "refused") {
          this.#record(sessionId, { kind: "unreadable", refusal: subscription });
          throw new ConsoleRefusalError(subscription);
        }
        // Held so a console surface can raise the same signal the daemon raises, and
        // released with the subscription itself — a handler outliving the mount that
        // registered it would re-read through a seam nobody is rendering.
        const handlers = this.#presenceHandlersBySession.get(sessionId) ?? new Set();
        handlers.add(onPresenceChange);
        this.#presenceHandlersBySession.set(sessionId, handlers);
        return () => {
          handlers.delete(onPresenceChange);
          if (handlers.size === 0) {
            this.#presenceHandlersBySession.delete(sessionId);
          }
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
   * Raise the same change signal the daemon's presence channel raises.
   *
   * THE ONE MECHANISM THAT RE-READS THE ABSORBED ROSTER WITHOUT EDITING IT. That view
   * holds its state against the `(seam, session)` pair it read for and seeds a new pair
   * at `loading`, so handing it a fresh seam to force a refresh would return a live
   * roster to its loading shape — which is exactly the flash its own tripwire forbids.
   * Its presence handler is the seam the contract already gives for this: a push says
   * WHEN to re-read, the view re-reads through its own path, and its refresh
   * deliberately never re-enters `loading`.
   *
   * A window regaining focus is a legitimate raiser of that signal and not a
   * substitute for it. The channel stayed open while the window was away; what is
   * unknown is whether every push over it arrived, and one read settles that.
   */
  public requestReRead(sessionId: string): void {
    const handlers = this.#presenceHandlersBySession.get(sessionId);
    if (handlers === undefined) {
      return;
    }
    for (const onPresenceChange of [...handlers]) {
      onPresenceChange();
    }
  }

  public watch(onObservationChanged: () => void): () => void {
    this.#watchers.add(onObservationChanged);
    return () => {
      this.#watchers.delete(onObservationChanged);
    };
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

/** This window's seams. Not exported: the two accessors below are the way in. */
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
 * Re-read the absorbed roster when this window comes back to the front.
 *
 * ONLY THE FOCUS ARM IS FORWARDED. `useWindowReadTriggers` also fires on mount, and
 * that arm is the absorbed view's own initial read — forwarding it would put a second
 * `runtimenode.roster` on the wire for one mount, which is the duplication this whole
 * module exists to avoid.
 *
 * `NO_TRIGGERING_EVENT_KINDS` is the claim that goes with it: the roster is served by
 * the control plane and pushed over the daemon's presence channel, so nothing in any
 * session's own timeline says a node moved.
 */
export function useNodeRosterFocusReRead(
  bridge: ConsoleBridge,
  sessionId: SessionId | string | undefined,
): void {
  const seam = nodeRosterSeams.forBridge(bridge);
  const target = useMemo<ReadTriggerTarget>(
    () => ({
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: (reason) => {
        if (reason !== "window-focus" || sessionId === undefined) {
          return;
        }
        seam.requestReRead(sessionId);
      },
    }),
    [seam, sessionId],
  );
  useWindowReadTriggers(target);
}
