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
 * This window's pin map, held for as long as the window is open.
 *
 * ONE HOLDER PER WINDOW AND NOT ONE PER MOUNT, on the precedent
 * `features/settings/machine-settings/machine-settings-holder.ts` states in its own
 * words: module scope IS window scope here, since an auxiliary window is its own
 * renderer process and no channel joins two windows' module graphs. Minted inside the
 * hook instead, a second visit to the sessions destination built a second store over
 * the one database — two writers of one record, each spreading its own in-memory copy
 * of it over the other's writes.
 *
 * A `const` holding an encapsulated object rather than a module-level `let` or `Map`,
 * which the state-and-views rule in `apps/desktop/AGENTS.md` rejects: the supersession
 * rule is an invariant over two fields moving together and is only checkable with one
 * owner.
 */
const consoleSessionPins = new DurableViewBindingHolder(mintSessionPinStore);

/**
 * Bind the pin map into a component.
 *
 * KEYED ON THE STORE'S IDENTITY, through this window's one pin holder. It was built
 * by a `useState` initializer instead — which runs once per mounted component and is
 * never recomputed — so when `frame/bindings/ui-state-lifecycle.ts` replaced this window's
 * store after a bridge or scenario change, the pins stayed attached to the closed
 * one: the previous scenario's map stayed on screen, every later write went to a
 * database nothing reads, and the replacement was never hydrated. The HOLDER's own
 * lifetime was the mount's for the same reason and cost the mirror image of it — a
 * second visit to this destination minted a rival store over the live database.
 *
 * The hydrate rides the holder's own effect, so a render pass React discards still
 * performs no durable read.
 */
export function useSessionPins(store: UiStateStore): SessionPinBinding {
  const { binding, acquire } = useDurableViewBinding(consoleSessionPins, store);
  const subscribe = useCallback(
    (onStoreChange: () => void) => binding?.subscribe(onStoreChange) ?? noDurableViewSubscription,
    [binding],
  );
  const readPinned = useCallback(() => binding?.pinned ?? NO_PINS, [binding]);
  const pinned = useSyncExternalStore(subscribe, readPinned, readPinned);
  // Read AFTER the subscription, deliberately. A write whose refusal CHANGED —
  // raised or cleared — emits on its own, so the component re-renders and this
  // getter is re-read; folding the refusal into the subscribed value instead would
  // change the map's identity on a write that did not change the map, and every
  // memoised row would re-render.
  const setPinned = useCallback(setPinnedThrough(acquire), [acquire]);
  return { pinned, lastRefusal: binding?.lastRefusal, setPinned };
}

/**
 * The pin act, bound to whatever store the acquirer is holding when it is pressed.
 *
 * Module-level and taking the acquirer, so the act's own two arguments are its
 * parameters and nothing else.
 */
function setPinnedThrough(
  acquire: () => SessionPinStore,
): (sessionId: string, isPinned: boolean) => void {
  return (sessionId, isPinned) => {
    // Not awaited, and the rejection cannot escape: `setPinned` declares its failure
    // as a recorded refusal rather than as a rejection.
    void acquire().setPinned(sessionId, isPinned);
  };
}
