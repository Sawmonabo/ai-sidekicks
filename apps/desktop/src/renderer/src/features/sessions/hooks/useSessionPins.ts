import { useCallback, useSyncExternalStore } from "react";

import { useKeyBoundValue } from "#renderer/hooks/useKeyBoundValue.js";
import { KeyBoundHolder } from "#renderer/lib/key-bound-holder.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import { NO_PINS, SessionPinStore, type SessionPinBinding } from "../rows/pins.js";

/** How a pin store is minted. Module-level, because the holder reads it once. */
function mintSessionPinStore(store: UiStateStore): SessionPinStore {
  return new SessionPinStore(store);
}

/**
 * Read the durable record once a store is acquired. Idempotent, so a re-acquired store asks once;
 * module-level, so the hook's effect sees one reference.
 */
function hydrateSessionPinStore(pinStore: SessionPinStore): void {
  void pinStore.hydrate();
}

/**
 * This window's pin holder, keyed on the durable store's identity. Module scope is window scope;
 * minted per mount, a second visit would build a second store over the one database, two writers
 * each spreading its own copy over the other's writes. A `const` holding an encapsulated object,
 * not a module-level `let` or `Map`.
 */
const sessionPinsHolder = new KeyBoundHolder(mintSessionPinStore);

/**
 * Bind the pin map into a component. Keyed on the store's identity through this window's one
 * holder, so a replaced store rebinds instead of leaving the pins on the closed one. The
 * hydrate rides the holder's effect, so a discarded render performs no durable read.
 */
export function useSessionPins(store: UiStateStore): SessionPinBinding {
  const {
    value: binding,
    acquire,
    subscribe,
  } = useKeyBoundValue(sessionPinsHolder, store, hydrateSessionPinStore);
  const readPinned = useCallback(() => binding?.pinned ?? NO_PINS, [binding]);
  const pinned = useSyncExternalStore(subscribe, readPinned, readPinned);
  // Read after the subscription on purpose: a write whose refusal changed emits on its own and
  // re-renders. Folding the refusal into the subscribed value would change the map's identity
  // on a write that did not change the map and re-render every memoized row.
  const setPinned = useCallback(setPinnedThrough(acquire), [acquire]);
  return { pinned, lastRefusal: binding?.lastRefusal, setPinned };
}

/** The pin act, bound to whatever store the acquirer holds when it is pressed. */
function setPinnedThrough(
  acquire: () => SessionPinStore,
): (sessionId: string, isPinned: boolean) => void {
  return (sessionId, isPinned) => {
    // Not awaited: `setPinned` records its failure as a refusal instead of rejecting.
    void acquire().setPinned(sessionId, isPinned);
  };
}
