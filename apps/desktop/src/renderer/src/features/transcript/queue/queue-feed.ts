// The window's registry of live queue readings, and the hook a view reads one through. Views
// on one bridge and session share one snapshot read and one tail, opened by the first watcher
// and closed by the last. Calls come from the minting view through a forwarder that reads its
// latest calls, so a new `QueueCalls` object each render is fine.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useLatestRef } from "@renderer/hooks/useLatestRef.js";
import { useSessionReadTriggers } from "@renderer/store/reads/hooks/useSessionReadTriggers.js";
import { useWindowReadTriggers } from "@renderer/store/reads/hooks/useWindowReadTriggers.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type Clock } from "@renderer/lib/clock.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { SessionQueueReading, type QueueCalls, type QueueFeed } from "./queue-reading.js";

/**
 * Every live reading in this window, keyed by bridge and session. The `WeakMap` on the bridge
 * lets a closed window take its readings with it; an entry drops once nobody is watching.
 */
class SessionQueueReadings {
  readonly #bySession = new WeakMap<PlatformBridge, Map<string, SessionQueueReading>>();

  /**
   * The live reading for this pair, minting one where the entry is free. Called from render and
   * from a subscription's setup: React runs cleanups before setups, so a pane swap can retire
   * the reading between a view's render and its subscribe, and resolving again at subscribe
   * time keeps exactly one live registered reading.
   */
  public reading(
    bridge: PlatformBridge,
    clock: Clock,
    sessionId: string,
    calls: QueueCalls,
  ): SessionQueueReading {
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
    const created = new SessionQueueReading(clock, sessionId, calls, () => {
      // Identity-checked, not `delete(sessionId)`: the key may already hold a successor reading
      // with watchers of its own. A retiring reading may only remove itself.
      if (forThisBridge.get(sessionId) === created) {
        forThisBridge.delete(sessionId);
      }
    });
    forBridge.set(sessionId, created);
    return created;
  }

  /** Watch this pair's reading, resolved at subscribe time rather than at render. */
  public watch(
    bridge: PlatformBridge,
    clock: Clock,
    sessionId: string,
    calls: QueueCalls,
    listener: () => void,
  ): () => void {
    return this.reading(bridge, clock, sessionId, calls).watch(listener);
  }
}

const sessionQueueReadings = new SessionQueueReadings();

/**
 * Read one session's queue through the calls it is handed. The window half of the read triggers
 * is wired here and the session half is `useQueueRepairRead`, because a caller of this hook may
 * hold only the session id and a repair is a fact about a session store.
 */
export function useQueueFeed(
  bridge: PlatformBridge,
  sessionId: string,
  calls: QueueCalls,
): QueueFeed {
  const clock = useBridgeClock();
  const forwardedCalls = useForwardedCalls(calls);
  // Both callbacks resolve through the registry rather than closing over this render's reading:
  // it can be retired before the subscription's setup, and watching it would revive it outside
  // the registry.
  const subscribe = useCallback(
    (onFeedChanged: () => void) =>
      sessionQueueReadings.watch(bridge, clock, sessionId, forwardedCalls, onFeedChanged),
    [bridge, clock, sessionId, forwardedCalls],
  );
  const readFeed = useCallback(
    () => sessionQueueReadings.reading(bridge, clock, sessionId, forwardedCalls).snapshot(),
    [bridge, clock, sessionId, forwardedCalls],
  );
  // Resolved at trigger time for the same reason, so the mount trigger fires once per pair
  // rather than once per render.
  const readTrigger = useMemo<ReadTriggerTarget>(
    () => ({
      get triggeringEventKinds(): ReadonlySet<string> {
        return sessionQueueReadings.reading(bridge, clock, sessionId, forwardedCalls)
          .triggeringEventKinds;
      },
      requestRead: (reason: RefreshReason): void => {
        sessionQueueReadings.reading(bridge, clock, sessionId, forwardedCalls).requestRead(reason);
      },
    }),
    [bridge, clock, sessionId, forwardedCalls],
  );
  const feed = useSyncExternalStore(subscribe, readFeed, readFeed);
  // Wired after the subscription, and the order is load-bearing: the subscription opens the
  // reading and takes its first read, so an earlier wiring would ask an unopened reading for a
  // `subscribe` read and cost a second one.
  useWindowReadTriggers(readTrigger, bridge.transportReconnect);

  return feed;
}

/**
 * Re-read one session's queue when its stream is repaired, meaning the session's degraded cause
 * clears. A view holding the session store calls this beside `useQueueFeed`; one holding only
 * the id still re-reads on mount and on focus.
 */
export function useQueueRepairRead(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  calls: QueueCalls,
): void {
  const { sessionId } = sessionStore;
  const clock = useBridgeClock();
  const forwardedCalls = useForwardedCalls(calls);
  const readTrigger = useMemo<ReadTriggerTarget>(
    () => ({
      get triggeringEventKinds(): ReadonlySet<string> {
        return sessionQueueReadings.reading(bridge, clock, sessionId, forwardedCalls)
          .triggeringEventKinds;
      },
      requestRead: (reason: RefreshReason): void => {
        sessionQueueReadings.reading(bridge, clock, sessionId, forwardedCalls).requestRead(reason);
      },
    }),
    [bridge, clock, sessionId, forwardedCalls],
  );
  useSessionReadTriggers(readTrigger, sessionStore);
}

/**
 * The calls a reading makes, forwarded to the latest committed `calls`. Stable for the life of
 * the view, so a new `calls` object each render neither re-subscribes nor is ignored.
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
