// Every live account-plane quota reading in this window, and the door a surface reads
// one through.
//
// `provider-account-quota.ts` owns what ONE reading says; this module owns how many
// there are and how long each lives — the split `queue-feed.ts` and `queue-reading.ts`
// already make, for the same reason.
//
// NODE-SCOPED, SO THE KEY IS THE BRIDGE AND NOT A SESSION. The registry these readings
// come from is the machine's: two sessions open in one window ask the same question
// and are served by one read and one tail. The entry opens them when the first watcher
// arrives and forgets them when the last leaves, so a window with no quota surface
// mounted holds no subscription and a surface that mounts later reads afresh rather
// than being handed a list that stopped being updated when nobody was watching it.

import { useCallback, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "./console-bridge.js";
import { NodeProviderQuotaReading, type ProviderQuotaReadout } from "./provider-account-quota.js";

/**
 * The window's readings, one per bridge.
 *
 * A `WeakMap` on the bridge so a closed window takes its reading with it, and the
 * entry is dropped once nobody is watching.
 */
class NodeProviderQuotaReadings {
  readonly #byBridge = new WeakMap<ConsoleBridge, NodeProviderQuotaReading>();

  /**
   * The live reading for this bridge, minting one where the entry is free.
   *
   * Resolved at subscribe time as well as at render, for the reason `queue-feed.ts`
   * states: React runs cleanups before setups, so a pane swap retires the reading
   * between a mounting surface's render and its subscribe.
   */
  public reading(bridge: ConsoleBridge): NodeProviderQuotaReading {
    const held = this.#byBridge.get(bridge);
    if (held !== undefined) {
      return held;
    }
    const byBridge = this.#byBridge;
    const created = new NodeProviderQuotaReading(bridge, () => {
      // Identity-checked: a retiring reading may only remove ITSELF, never whatever
      // successor is registered under its key by the time its last watcher leaves.
      if (byBridge.get(bridge) === created) {
        byBridge.delete(bridge);
      }
    });
    this.#byBridge.set(bridge, created);
    return created;
  }

  /** Watch this bridge's reading, resolved at subscribe time rather than at render. */
  public watch(bridge: ConsoleBridge, listener: () => void): () => void {
    return this.reading(bridge).watch(listener);
  }
}

const nodeProviderQuotaReadings = new NodeProviderQuotaReadings();

/**
 * Read this node's provider-account quotas.
 *
 * Every consumer on one bridge is served by one read and one subscription. No timer
 * and no poll: the tail is what makes a reading current, and a surface that polled
 * would be asking a registry that already tells it when something moved.
 */
export function useProviderQuotas(bridge: ConsoleBridge): ProviderQuotaReadout {
  // Through the registry on both callbacks rather than over a reading this render
  // resolved: a reading retired between render and subscribe used to be revived by
  // the watch, live and outside the map, so one bridge carried two tails.
  const subscribe = useCallback(
    (onReadoutChanged: () => void) => nodeProviderQuotaReadings.watch(bridge, onReadoutChanged),
    [bridge],
  );
  const readReadout = useCallback(
    () => nodeProviderQuotaReadings.reading(bridge).snapshot(),
    [bridge],
  );
  return useSyncExternalStore(subscribe, readReadout, readReadout);
}
