// The app's frame stores, one per open window, and the one subscription to main's report of the
// background service, which every window's store keeps: each change crosses from main once
// however many windows are open.

import { useEffect, useState } from "react";

import { subscribeDaemonStatus } from "#renderer/services/daemon/status.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";
import { WindowStores } from "../window-stores.js";

/** Every open window's frame store, kept while the app holds `bridge`; a closed window's goes. */
export function useWindowStores(openWindows: OpenWindows, bridge: PlatformBridge): WindowStores {
  const [windowStores] = useState(() => new WindowStores());
  useEffect(
    () =>
      subscribeDaemonStatus(bridge, (report) => {
        windowStores.publishMainProcessReport(report);
      }),
    [bridge, windowStores],
  );
  useEffect(
    () =>
      openWindows.subscribe(() => {
        windowStores.keepOnly(new Set(openWindows.list().map(({ windowId }) => windowId)));
      }),
    [openWindows, windowStores],
  );
  return windowStores;
}
