import { useCallback, useSyncExternalStore } from "react";

import type { OpenWindow, OpenWindows } from "#renderer/services/window/open-windows.js";

/** The open windows, the one used last first, read again on every open, close and focus move. */
export function useOpenWindowList(openWindows: OpenWindows): readonly OpenWindow[] {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => openWindows.subscribe(onChange), [openWindows]),
    useCallback(() => openWindows.list(), [openWindows]),
  );
}
