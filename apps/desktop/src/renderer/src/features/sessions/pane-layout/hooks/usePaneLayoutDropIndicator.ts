import { useCallback, useSyncExternalStore } from "react";

import { type DeckDragCoordinator, type PaneDropIndicator } from "../pane-drag.js";

/** Subscribe to the indicator. The one read path; no component reads `snapshot()`. */
export function useDeckDropIndicator(
  coordinator: DeckDragCoordinator,
): PaneDropIndicator | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => coordinator.subscribe(onStoreChange),
    [coordinator],
  );
  const read = useCallback(() => coordinator.snapshot(), [coordinator]);
  return useSyncExternalStore(subscribe, read, read);
}
