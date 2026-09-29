// Every live queue reading in this window, and the door a surface reads one through.
//
// `queue-reading.ts` owns what ONE session's reading says; this module owns how many
// there are and how long each lives. Every surface on one bridge and session is
// served by one snapshot read and one tail: the entry opens them when the first
// watcher arrives and forgets them when the last leaves, so a window with no queue
// surface mounted holds no subscription and a surface that mounts later reads afresh.
//
// The calls are supplied by the surface that mints a reading, through a forwarder that
// reads that surface's latest calls, so a surface may hand over a new `QueueCalls`
// object each render. A later surface on the same bridge and session shares that
// reading and the forwarder it was minted with.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useLatestRef } from "@renderer/console/primitives/index.js";
import { useSessionReadTriggers } from "@renderer/store/reads/hooks/useSessionReadTriggers.js";
import { useWindowReadTriggers } from "@renderer/store/reads/hooks/useWindowReadTriggers.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { SessionQueueReading, type QueueCalls, type QueueFeed } from "./queue-reading.js";

/**
 * Every live reading in this window, keyed by the bridge and the session.
 *
 * A `WeakMap` on the bridge so a closed window takes its readings with it, and the
 * entry itself is dropped once nobody is watching.
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
   * commit end with ONE live registered reading.
   */
  public reading(bridge: ConsoleBridge, sessionId: string, calls: QueueCalls): SessionQueueReading {
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
    const created = new SessionQueueReading(bridge, sessionId, calls, () => {
      // Identity-checked, not `delete(sessionId)`: the entry under that key may already
      // be a successor reading with watchers of its own. A retiring reading may only
      // remove itself.
      if (forThisBridge.get(sessionId) === created) {
        forThisBridge.delete(sessionId);
      }
    });
    forBridge.set(sessionId, created);
    return created;
  }

  /** Watch this pair's reading, resolved at subscribe time rather than at render. */
  public watch(
    bridge: ConsoleBridge,
    sessionId: string,
    calls: QueueCalls,
    listener: () => void,
  ): () => void {
    return this.reading(bridge, sessionId, calls).watch(listener);
  }
}

const sessionQueueReadings = new SessionQueueReadings();

/**
 * Read one session's queue through the calls it is handed.
 *
 * Every surface on one bridge and session is served by one snapshot read and one
 * tail. The watcher count is what opens and closes them, so a window with no queue
 * surface mounted holds no subscription. The window half of the trigger set is wired
 * here and the session half is `useQueueRepairRead`: this hook is reached by a caller
 * that holds only the session id, and a repair is a fact about a session store.
 */
export function useQueueFeed(
  bridge: ConsoleBridge,
  sessionId: string,
  calls: QueueCalls,
): QueueFeed {
  const forwardedCalls = useForwardedCalls(calls);
  // Both callbacks go through the registry rather than closing over the reading this
  // render resolved: that reading can be retired before React runs the subscription's
  // setup, and watching a retired one would revive it outside the registry.
  const subscribe = useCallback(
    (onFeedChanged: () => void) =>
      sessionQueueReadings.watch(bridge, sessionId, forwardedCalls, onFeedChanged),
    [bridge, sessionId, forwardedCalls],
  );
  const readFeed = useCallback(
    () => sessionQueueReadings.reading(bridge, sessionId, forwardedCalls).snapshot(),
    [bridge, sessionId, forwardedCalls],
  );
  // Resolved at trigger time for the same reason, so the mount trigger fires once per
  // pair rather than once per render.
  const readTrigger = useMemo<ReadTriggerTarget>(
    () => ({
      get triggeringEventKinds(): ReadonlySet<string> {
        return sessionQueueReadings.reading(bridge, sessionId, forwardedCalls).triggeringEventKinds;
      },
      requestRead: (reason: RefreshReason): void => {
        sessionQueueReadings.reading(bridge, sessionId, forwardedCalls).requestRead(reason);
      },
    }),
    [bridge, sessionId, forwardedCalls],
  );
  const feed = useSyncExternalStore(subscribe, readFeed, readFeed);
  // Wired after the subscription, and the order is load-bearing: the subscription is
  // what opens the reading and takes its first read, so a trigger set wired ahead of it
  // would ask an unopened reading for a `subscribe` read and cost a second one.
  useWindowReadTriggers(readTrigger, bridge.transportReconnect);

  return feed;
}

/**
 * Re-read one session's queue when its stream is repaired.
 *
 * A surface holding the session store calls this beside `useQueueFeed`; one holding
 * only the id still re-reads on mount and on focus. The store's sticky degraded flag
 * clearing is the console's nearest reading of a stream that stopped and came back.
 */
export function useQueueRepairRead(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  calls: QueueCalls,
): void {
  const { sessionId } = sessionStore;
  const forwardedCalls = useForwardedCalls(calls);
  const readTrigger = useMemo<ReadTriggerTarget>(
    () => ({
      get triggeringEventKinds(): ReadonlySet<string> {
        return sessionQueueReadings.reading(bridge, sessionId, forwardedCalls).triggeringEventKinds;
      },
      requestRead: (reason: RefreshReason): void => {
        sessionQueueReadings.reading(bridge, sessionId, forwardedCalls).requestRead(reason);
      },
    }),
    [bridge, sessionId, forwardedCalls],
  );
  useSessionReadTriggers(readTrigger, sessionStore);
}

/**
 * The calls a reading makes, forwarded to the latest committed `calls`.
 *
 * Stable for the life of the surface, so a new `calls` object each render neither
 * re-subscribes the reading nor is ignored by one already minted.
 */
function useForwardedCalls(calls: QueueCalls): QueueCalls {
  const latest = useLatestRef(calls);
  return useMemo<QueueCalls>(
    () => ({
      list: (sessionId) => latest.current.list(sessionId),
      tail: (sessionId, onItem) => latest.current.tail(sessionId, onItem),
      cancel: (queueItemId) => latest.current.cancel(queueItemId),
    }),
    [latest],
  );
}
