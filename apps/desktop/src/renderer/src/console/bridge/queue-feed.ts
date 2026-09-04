// Every live queue reading in this window, and the door a surface reads one through.
//
// `queue-reading.ts` owns what ONE session's reading says; this module owns how many
// there are and how long each lives. Every surface on one bridge and session is
// served by one snapshot read and one tail: the entry opens them when the first
// watcher arrives and forgets them when the last leaves, so a window with no queue
// surface mounted holds no subscription and a surface that mounts later reads afresh
// rather than being handed a list that stopped being updated when nobody was
// watching it.

import { useCallback, useSyncExternalStore } from "react";

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
      forThisBridge.delete(sessionId);
    });
    forBridge.set(sessionId, created);
    return created;
  }
}

const sessionQueueReadings = new SessionQueueReadings();

/**
 * Read one session's queue.
 *
 * Every surface on one bridge and session is served by one snapshot read and one
 * tail. The watcher count is what opens and closes them, so a window with no queue
 * surface mounted holds no subscription.
 */
export function useQueueFeed(bridge: ConsoleBridge, sessionId: string): QueueFeed {
  const reading = sessionQueueReadings.reading(bridge, sessionId);
  const subscribe = useCallback(
    (onFeedChanged: () => void) => reading.watch(onFeedChanged),
    [reading],
  );
  return useSyncExternalStore(subscribe, reading.snapshot, reading.snapshot);
}
