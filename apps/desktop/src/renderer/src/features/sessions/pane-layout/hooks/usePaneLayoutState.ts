import { useCallback, useSyncExternalStore } from "react";

import { type PaneLayoutState } from "../state.js";
import { type PaneLayoutStore } from "../store.js";

/** Subscribes to a layout and returns its state; components read through this, not `snapshot()`. */
export function usePaneLayoutState(layout: PaneLayoutStore): PaneLayoutState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => layout.subscribe(onStoreChange),
    [layout],
  );
  const read = useCallback(() => layout.snapshot(), [layout]);
  return useSyncExternalStore(subscribe, read, read);
}
