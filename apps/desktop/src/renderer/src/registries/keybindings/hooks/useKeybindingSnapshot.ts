import { useCallback, useSyncExternalStore } from "react";

import type { KeybindingOverrideStore } from "../keybinding-override-store.js";
import type { KeybindingSnapshot } from "../override-types.js";

/**
 * Reads the override store from a component and re-renders when an override is written. It uses
 * `useSyncExternalStore` because an effect misses an override written between render and subscribe.
 */
export function useKeybindingSnapshot(store: KeybindingOverrideStore): KeybindingSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(onStoreChange),
    [store],
  );
  const read = useCallback(() => store.snapshot, [store]);
  return useSyncExternalStore(subscribe, read, read);
}
