// The app's frame stores, one per open window, and the one subscription to main's report of the
// background service, which every window's store keeps: each change crosses from main once
// however many windows are open.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { subscribeDaemonStatus } from "#renderer/services/daemon/status.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";
import { WindowStores, type OpenWindowStore } from "../window/stores.js";

/** Every open window's frame store, and the open windows with their stores to draw. */
export interface AppWindowStores {
  readonly windowStores: WindowStores;
  /** The open windows with their stores, the one used last first, read again on each change. */
  readonly windows: readonly OpenWindowStore[];
}

/**
 * Every open window's frame store, built as its window opens and kept while the app holds
 * `bridge`; a closed window's goes.
 */
export function useWindowStores(openWindows: OpenWindows, bridge: PlatformBridge): AppWindowStores {
  const [windowStores] = useState(() => new WindowStores());
  useEffect(
    () =>
      subscribeDaemonStatus(bridge, (report) => {
        windowStores.publishMainProcessReport(report);
      }),
    [bridge, windowStores],
  );
  useEffect(() => windowStores.follow(openWindows), [openWindows, windowStores]);
  const windows = useSyncExternalStore(
    useCallback((onChange: () => void) => windowStores.subscribe(onChange), [windowStores]),
    useCallback(() => windowStores.list(), [windowStores]),
  );
  return { windowStores, windows };
}
