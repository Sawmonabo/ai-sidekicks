import { useCallback, useSyncExternalStore } from "react";

import { type PaneLayoutState } from "../pane-layout.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";

/** Subscribe to a layout. The one read path; no component reaches `snapshot()`. */
export function usePaneLayoutState(layout: PaneLayoutStore): PaneLayoutState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => layout.subscribe(onStoreChange),
    [layout],
  );
  const read = useCallback(() => layout.snapshot(), [layout]);
  return useSyncExternalStore(subscribe, read, read);
}
