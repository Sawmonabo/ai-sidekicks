import { useCallback, useSyncExternalStore } from "react";

import type { KeybindingOverrideStore } from "../keybinding-override-store.js";
import type { KeybindingSnapshot } from "../keybinding-override-types.js";

/**
 * Read the seam from a component, re-rendering when an override is written.
 *
 * `useSyncExternalStore` rather than an effect writing into state: an override
 * written between a render and its subscription is missed by the effect shape, and a
 * keyboard silently disagreeing with the page describing it is the failure this seam
 * exists to prevent.
 */
export function useKeybindingSurface(store: KeybindingOverrideStore): KeybindingSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(onStoreChange),
    [store],
  );
  const read = useCallback(() => store.surface, [store]);
  return useSyncExternalStore(subscribe, read, read);
}
