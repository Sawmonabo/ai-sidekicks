import { useCallback, useSyncExternalStore } from "react";

import { type PaneLayoutDragCoordinator, type PaneDropIndicator } from "../pane-drag.js";

/** Subscribe to the indicator. The one read path; no component reads `snapshot()`. */
export function usePaneLayoutDropIndicator(
  coordinator: PaneLayoutDragCoordinator,
): PaneDropIndicator | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => coordinator.subscribe(onStoreChange),
    [coordinator],
  );
  const read = useCallback(() => coordinator.snapshot(), [coordinator]);
  return useSyncExternalStore(subscribe, read, read);
}
