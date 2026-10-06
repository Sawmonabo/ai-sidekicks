// Opening the app's windows and keeping where they were. The window used last opens first, on the
// address the launch named, then the rest from the kept window layout, each on the address it was
// kept on; a launch that named no address brings the window used last back to its own kept address
// too, unless the person has already moved it. The kept layout then follows the open windows and
// every window's address, and only once its own read has settled, so a start never writes over
// the layout it is about to read. A window main asks for, when none a person sees is open, opens
// on the sessions list. A safe start opens that one window on the sessions list, reads no kept
// layout and leaves it as it was, until `Restore windows` reopens the kept windows and tells main
// the safe start ended.

import { useCallback, useEffect, useState } from "react";

import { DEFAULT_ROUTE, formatRoute, parseRoute, type AppRoute } from "#renderer/routing/routes.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { useWindowRestore } from "#renderer/services/window/hooks/useWindowRestore.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  keepWindows,
  readKeptWindows,
  type KeptWindow,
} from "#renderer/store/window-layout/kept-window-layout.js";
import { SAFE_START_ATTRIBUTE } from "#shared/window/safe-start.js";
import { prepareWindowDocument } from "../window-document.js";
import type { WindowStores } from "../window-stores.js";

/** What the windows' opening offers the person: the safe start's way back to the kept windows. */
export interface KeptWindowLayout {
  /** Whether a safe start is holding the kept windows back, so its line shows. */
  readonly isRestoreOffered: boolean;
  /**
   * Reopen every kept window on its kept address and end the safe start; the kept layout follows
   * the windows after.
   */
  readonly restoreWindows: () => void;
}

/** What the windows are opened through and kept in. */
export interface KeptWindowLayoutOptions {
  readonly openWindows: OpenWindows;
  readonly bridge: PlatformBridge;
  readonly uiStateStore: UiStateStore;
  readonly windowStores: WindowStores;
  /** The console document, which carries the launch's address and the safe-start mark. */
  readonly consoleDocument: Document;
}

/** Open the app's windows once, keep their layout from then on, and close them all on unmount. */
export function useKeptWindowLayout(options: KeptWindowLayoutOptions): KeptWindowLayout {
  const { openWindows, bridge, uiStateStore, windowStores, consoleDocument } = options;
  // Read once: main marks the console document it serves, and the mark does not change.
  const [isSafeStart] = useState(() =>
    consoleDocument.documentElement.hasAttribute(SAFE_START_ATTRIBUTE),
  );
  // Whether the kept layout follows the windows: once its read settled, or once restored.
  const [isLayoutKept, setLayoutKept] = useState(false);

  useEffect(() => {
    let isOpening = true;
    const stopPreparing = openWindows.prepareEveryDocument(prepareWindowDocument);
    const windowUsedLast = bridge.window.lastUsedWindowId;
    const consoleLocation = consoleDocument.location;
    const launchHash = consoleLocation.hash;
    openAt(openWindows, windowUsedLast, isSafeStart ? DEFAULT_ROUTE : parseRoute(launchHash));
    if (!isSafeStart) {
      void readKeptWindows(uiStateStore).then((keptWindows) => {
        if (!isOpening) {
          return;
        }
        for (const keptWindow of keptWindows) {
          if (keptWindow.windowId !== windowUsedLast) {
            openAt(openWindows, keptWindow.windowId, keptWindow.route);
          } else if (launchHash === "") {
            returnToKeptAddress(openWindows, keptWindow);
          }
        }
        setLayoutKept(true);
      });
    }
    // The launch's address went to the window used last; the console document routes nothing.
    consoleDocument.defaultView?.history.replaceState(
      null,
      "",
      `${consoleLocation.pathname}${consoleLocation.search}`,
    );
    return () => {
      isOpening = false;
      stopPreparing();
      openWindows.closeAll();
    };
  }, [openWindows, bridge, isSafeStart, uiStateStore, consoleDocument]);

  // The kept layout follows the open windows and their addresses, dropping a closed window only
  // while another stays open, so the last window closed comes back on the next start.
  useEffect(() => {
    if (!isLayoutKept) {
      return undefined;
    }
    const keep = (): void => {
      const open = openWindows.list();
      if (open.length > 0) {
        void keepWindows(
          uiStateStore,
          open.map((openWindow) => ({
            windowId: openWindow.windowId,
            route: windowStores.storeFor(openWindow).getState().route,
          })),
        );
      }
    };
    keep();
    const stopHearingWindows = openWindows.subscribe(keep);
    const stopHearingRoutes = windowStores.subscribeRoutes(keep);
    return () => {
      stopHearingWindows();
      stopHearingRoutes();
    };
  }, [isLayoutKept, openWindows, uiStateStore, windowStores]);

  const reopenWindow = useCallback(
    (windowId: string) => {
      openAt(openWindows, windowId, DEFAULT_ROUTE);
    },
    [openWindows],
  );
  const endSafeStart = useWindowRestore(bridge.window, reopenWindow);

  const restoreWindows = useCallback(() => {
    void readKeptWindows(uiStateStore).then((keptWindows) => {
      for (const keptWindow of keptWindows) {
        openAt(openWindows, keptWindow.windowId, keptWindow.route);
      }
      setLayoutKept(true);
      return endSafeStart();
    });
  }, [openWindows, uiStateStore, endSafeStart]);

  return { isRestoreOffered: isSafeStart && !isLayoutKept, restoreWindows };
}

/**
 * Open `windowId` on `route`; nothing for a window already open. The address is written before
 * anything is drawn, so the window's store starts on it. It is written as the hash alone: a blank
 * document resolves a whole address against its opener's, which it may not take.
 */
function openAt(openWindows: OpenWindows, windowId: string, route: AppRoute): void {
  if (openWindows.list().some((openWindow) => openWindow.windowId === windowId)) {
    return;
  }
  openWindows.open(windowId).window.location.hash = formatRoute(route);
}

/**
 * Move the open window `keptWindow` names to its kept address, while it still shows the sessions
 * list it opened on. Through the hash, which the window's route binding adopts.
 */
function returnToKeptAddress(openWindows: OpenWindows, keptWindow: KeptWindow): void {
  const opened = openWindows.list().find(({ windowId }) => windowId === keptWindow.windowId);
  if (opened !== undefined && opened.window.location.hash === formatRoute(DEFAULT_ROUTE)) {
    opened.window.location.hash = formatRoute(keptWindow.route);
  }
}
