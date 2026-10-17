// A route that names a session the background service no longer holds (an address, a banner, a
// notification) does not leave the window on a frame that will never fill: once the session's read
// answers that it is gone, the window steps back to the screen shown before and says
// `Session not found` there. The registry closes the gone session once no screen shows it.

import { useEffect } from "react";

import { type SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { type WindowStore } from "#renderer/store/window/store.js";

/** Step this window back off the session its route names once that session's read says it is gone. */
export function useGoneSessionReturn(
  frameStore: WindowStore,
  registry: SessionStoreRegistry,
): void {
  useEffect(
    () =>
      registry.subscribeToReadFailures((sessionId) => {
        if (registry.isGone(sessionId)) {
          frameStore.leaveGoneSession(sessionId);
        }
      }),
    [frameStore, registry],
  );
}
