// The app's frame stores, one per open window, and the one subscription to main's report of the
// background service, which every window's store keeps: each change crosses from main once
// however many windows are open. It also hands on whether the service has answered yet, which
// lifts every window's boot cover.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { subscribeDaemonStatus } from "#renderer/services/daemon/status.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";
import { WindowStores, type OpenWindowStore } from "../window/stores.js";

/**
 * Every open window's frame store, the open windows with their stores to draw, and whether the
 * service has answered.
 */
export interface AppWindowStores {
  readonly windowStores: WindowStores;
  /** The open windows with their stores, the one used last first, read again on each change. */
  readonly windows: readonly OpenWindowStore[];
  /** Whether the service has answered since the app opened; it never goes back to false. */
  readonly hasServiceAnswered: boolean;
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
  const subscribe = useCallback(
    (onChange: () => void) => windowStores.subscribe(onChange),
    [windowStores],
  );
  const windows = useSyncExternalStore(
    subscribe,
    useCallback(() => windowStores.list(), [windowStores]),
  );
  const hasServiceAnswered = useSyncExternalStore(
    subscribe,
    useCallback(() => windowStores.hasServiceAnswered, [windowStores]),
  );
  return { windowStores, windows, hasServiceAnswered };
}
