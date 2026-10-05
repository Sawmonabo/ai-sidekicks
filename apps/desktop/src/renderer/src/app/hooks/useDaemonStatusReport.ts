// What main says about the background service, kept in the window store for the window's life.
// One subscription per window, so every reader shares one answer to "is the service up".

import { useEffect } from "react";

import { subscribeDaemonStatus } from "#renderer/services/daemon/status.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { WindowStore } from "#renderer/store/window/window-store.js";

/** Keep main's report of the service in `frameStore` while the window holds `bridge`. */
export function useDaemonStatusReport(bridge: PlatformBridge, frameStore: WindowStore): void {
  useEffect(
    () =>
      subscribeDaemonStatus(bridge, (state) => {
        frameStore.publishMainProcessReport(state);
      }),
    [bridge, frameStore],
  );
}
