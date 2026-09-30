import { useCallback, useSyncExternalStore } from "react";

import { type PaneLayoutState } from "../pane-layout.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";

/** Subscribes to a layout and returns its state; components read through this, not `snapshot()`. */
export function usePaneLayoutState(layout: PaneLayoutStore): PaneLayoutState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => layout.subscribe(onStoreChange),
    [layout],
  );
  const read = useCallback(() => layout.snapshot(), [layout]);
  return useSyncExternalStore(subscribe, read, read);
}
