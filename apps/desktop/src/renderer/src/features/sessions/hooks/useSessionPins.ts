import { useCallback, useSyncExternalStore } from "react";

import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import {
  DurableViewBindingHolder,
  noDurableViewSubscription,
} from "../durable-view/durable-view-binding.js";
import { NO_PINS, SessionPinStore, type SessionPinBinding } from "../rows/session-pins.js";
import { useDurableViewBinding } from "./useDurableViewBinding.js";

/** How a pin store is minted. Module-level, because the holder reads it once. */
function mintSessionPinStore(store: UiStateStore): SessionPinStore {
  return new SessionPinStore(store);
}

/**
 * This window's pin holder. Module scope is window scope; minted per mount, a second visit would
 * build a second store over the one database, two writers each spreading its own copy over the
 * other's writes. A `const` holding an encapsulated object, not a module-level `let` or `Map`.
 */
const sessionPinsHolder = new DurableViewBindingHolder(mintSessionPinStore);

/**
 * Bind the pin map into a component. Keyed on the store's identity through this window's one
 * holder, so a replaced store rebinds instead of leaving the pins on the closed one. The
 * hydrate rides the holder's effect, so a discarded render performs no durable read.
 */
export function useSessionPins(store: UiStateStore): SessionPinBinding {
  const { binding, acquire } = useDurableViewBinding(sessionPinsHolder, store);
  const subscribe = useCallback(
    (onStoreChange: () => void) => binding?.subscribe(onStoreChange) ?? noDurableViewSubscription,
    [binding],
  );
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
