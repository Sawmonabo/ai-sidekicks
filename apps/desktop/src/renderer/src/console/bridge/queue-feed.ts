// Every live queue reading in this window, and the door a surface reads one through.
//
// `queue-reading.ts` owns what ONE session's reading says; this module owns how many
// there are and how long each lives. Every surface on one bridge and session is
// served by one snapshot read and one tail: the entry opens them when the first
// watcher arrives and forgets them when the last leaves, so a window with no queue
// surface mounted holds no subscription and a surface that mounts later reads afresh
// rather than being handed a list that stopped being updated when nobody was
// watching it.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  useSessionReadTriggers,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
} from "../store/index.js";

import type { ConsoleBridge } from "./console-bridge.js";
import { SessionQueueReading, type QueueFeed } from "./queue-reading.js";

/**
 * Every live reading in this window, keyed by the bridge and the session.
 *
 * A `WeakMap` on the bridge so a closed window takes its readings with it, and the
 * entry itself is dropped once nobody is watching — a surface that mounts later
 * reads afresh rather than being handed a list that stopped being updated when the
 * last watcher left.
 */
class SessionQueueReadings {
  readonly #bySession = new WeakMap<ConsoleBridge, Map<string, SessionQueueReading>>();

  /**
   * The live reading for this pair, minting one where the entry is free.
   *
   * Called from a render AND from a subscription's setup, and both matter: React runs
   * cleanups before setups, so the pane swap that unmounts one surface and mounts
   * another in the same commit retires the reading between the mounting surface's
   * render and its subscribe. Resolving again at subscribe time is what makes that
   * commit end with ONE live registered reading rather than a revived unregistered one
   * beside a freshly minted one.
   */
  public reading(bridge: ConsoleBridge, sessionId: string): SessionQueueReading {
    let forBridge = this.#bySession.get(bridge);
    if (forBridge === undefined) {
      forBridge = new Map<string, SessionQueueReading>();
      this.#bySession.set(bridge, forBridge);
    }
    const held = forBridge.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    const forThisBridge = forBridge;
    const created = new SessionQueueReading(bridge, sessionId, () => {
      // IDENTITY-CHECKED, not `delete(sessionId)`. The closure captures the map and
      // the key but the entry under that key may already be a SUCCESSOR reading with
      // watchers of its own, and an unconditional delete evicts it — so the next
      // surface mints a third reading and the second one is live and unregistered.
      // A retiring reading may only remove ITSELF.
      if (forThisBridge.get(sessionId) === created) {
        forThisBridge.delete(sessionId);
      }
    });
    forBridge.set(sessionId, created);
    return created;
  }

  /** Watch this pair's reading, resolved at subscribe time rather than at render. */
  public watch(bridge: ConsoleBridge, sessionId: string, listener: () => void): () => void {
    return this.reading(bridge, sessionId).watch(listener);
  }
}

const sessionQueueReadings = new SessionQueueReadings();

/**
 * Read one session's queue.
 *
 * Every surface on one bridge and session is served by one snapshot read and one
 * tail. The watcher count is what opens and closes them, so a window with no queue
 * surface mounted holds no subscription.
 *
 * THE WINDOW HALF OF THE TRIGGER SET IS WIRED HERE and the session half is
 * `useQueueRepairRead` below, for the reason `driver-capability-read.ts` splits the
 * same pair: this hook is reached by a caller that holds only the id it is addressed
 * at, and a connection whose repair is worth re-reading for is a fact about a session
 * STORE. Splitting keeps the id-only caller served rather than making it produce
 * something it does not have.
 */
export function useQueueFeed(bridge: ConsoleBridge, sessionId: string): QueueFeed {
  // Both callbacks go through the registry rather than closing over the reading this
  // render resolved. A reading captured at render can be retired before React runs
  // the subscription's setup — the pane swap where one surface unmounts and another
  // mounts in one commit — and watching it there used to REVIVE it, live and outside
  // the map, which is the second tail this module exists to prevent.
  const subscribe = useCallback(
    (onFeedChanged: () => void) => sessionQueueReadings.watch(bridge, sessionId, onFeedChanged),
    [bridge, sessionId],
  );
  const readFeed = useCallback(
    () => sessionQueueReadings.reading(bridge, sessionId).snapshot(),
    [bridge, sessionId],
  );
  // The trigger target resolves its reading at TRIGGER time for the same reason the
  // two callbacks do, and holds no reading of its own: the object is stable per pair,
  // so the mount trigger fires once per pair rather than once per render.
  const readTrigger = useMemo<ReadTriggerTarget>(
    () => ({
      get triggeringEventKinds(): ReadonlySet<string> {
        return sessionQueueReadings.reading(bridge, sessionId).triggeringEventKinds;
      },
      requestRead: (reason: RefreshReason): void => {
        sessionQueueReadings.reading(bridge, sessionId).requestRead(reason);
      },
    }),
    [bridge, sessionId],
  );
  const feed = useSyncExternalStore(subscribe, readFeed, readFeed);
  // WIRED AFTER THE SUBSCRIPTION, and the order is load-bearing. React runs a hook's
  // effects in the order the hooks were called, and `useSyncExternalStore`'s
  // subscription is what OPENS the reading — which takes its own first read. A
  // trigger set wired ahead of it would ask an unopened reading for a `subscribe`
  // read, and the open would then take a second one for the same arrival.
  useWindowReadTriggers(readTrigger);

  return feed;
}

/**
 * Re-read one session's queue when its stream is repaired.
 *
 * Separate from the hook above and deliberately so, exactly as the driver-capability
 * read splits its own pair: the reading is addressed at a session ID, and what says
 * a tail may have missed rows is the session STORE's sticky degraded flag clearing —
 * the console's nearest honest reading of a stream that stopped and came back.
 *
 * A surface holding the store calls this beside `useQueueFeed`; one holding only the
 * id still re-reads on mount and on focus. Both are served by the one reading, so the
 * repair read a session-holding surface asks for refreshes what every surface sees.
 */
export function useQueueRepairRead(bridge: ConsoleBridge, sessionStore: SessionStore): void {
  const { sessionId } = sessionStore;
  const readTrigger = useMemo<ReadTriggerTarget>(
    () => ({
      get triggeringEventKinds(): ReadonlySet<string> {
        return sessionQueueReadings.reading(bridge, sessionId).triggeringEventKinds;
      },
      requestRead: (reason: RefreshReason): void => {
        sessionQueueReadings.reading(bridge, sessionId).requestRead(reason);
      },
    }),
    [bridge, sessionId],
  );
  useSessionReadTriggers(readTrigger, sessionStore);
}
