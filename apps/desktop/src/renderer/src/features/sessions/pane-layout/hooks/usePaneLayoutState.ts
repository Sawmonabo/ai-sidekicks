import { useCallback, useSyncExternalStore } from "react";

import { type DeckLayoutState } from "../pane-layout.js";
import { type DeckLayout } from "../pane-layout-store.js";

/** Subscribe to a layout. The one read path; no component reaches `snapshot()`. */
export function useDeckLayoutState(layout: DeckLayout): DeckLayoutState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => layout.subscribe(onStoreChange),
    [layout],
  );
  const read = useCallback(() => layout.snapshot(), [layout]);
  return useSyncExternalStore(subscribe, read, read);
}
