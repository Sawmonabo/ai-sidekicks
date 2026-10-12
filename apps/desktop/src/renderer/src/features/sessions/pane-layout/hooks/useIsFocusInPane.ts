import { useCallback, useSyncExternalStore } from "react";

import { paneSlotSelector } from "../components/SessionPaneSlot.js";

/**
 * Whether the window `ownerDocument` belongs to has its focus inside one of a session's panes,
 * kept current as focus moves. The conversation beside the block is not a pane.
 */
export function useIsFocusInPane(ownerDocument: Document): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      ownerDocument.addEventListener("focusin", listener);
      ownerDocument.addEventListener("focusout", listener);
      return () => {
        ownerDocument.removeEventListener("focusin", listener);
        ownerDocument.removeEventListener("focusout", listener);
      };
    },
    [ownerDocument],
  );
  const readIsFocusInPane = useCallback(
    () => (ownerDocument.activeElement?.closest(paneSlotSelector()) ?? null) !== null,
    [ownerDocument],
  );
  return useSyncExternalStore(subscribe, readIsFocusInPane);
}
