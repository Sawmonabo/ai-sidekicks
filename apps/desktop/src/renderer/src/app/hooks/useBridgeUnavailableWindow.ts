import { useEffect, useState } from "react";

import type { OpenWindow, OpenWindows } from "#renderer/services/window/open-windows.js";
import { consoleWindowId } from "#shared/window/frame-name.js";
import { prepareWindowDocument } from "../window-document.js";
import { useOpenWindowList } from "./useOpenWindowList.js";

/**
 * The one window that says no bridge resolved, opened under a new id since no bridge says which
 * was used last, and closed on unmount; `undefined` until it is open.
 */
export function useBridgeUnavailableWindow(openWindows: OpenWindows): OpenWindow | undefined {
  const [windowId] = useState(() => consoleWindowId(crypto.randomUUID()));
  const windows = useOpenWindowList(openWindows);
  useEffect(() => {
    const stopPreparing = openWindows.prepareEveryDocument(prepareWindowDocument);
    openWindows.open(windowId);
    return () => {
      stopPreparing();
      openWindows.closeAll();
    };
  }, [openWindows, windowId]);
  return windows.find((openWindow) => openWindow.windowId === windowId);
}
