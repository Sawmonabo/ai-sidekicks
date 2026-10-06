// The store for the session the route names, opened from an effect so a discarded render pass
// cannot leave a session open that nothing closes.

import { useEffect } from "react";

import { useOpenSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import type { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { SessionStore } from "#renderer/store/session/store.js";

/**
 * The store for the session the route names, or `undefined` while it is opening.
 *
 * There is one frame between naming a session and the effect that opens it; `AppRouter` renders
 * that frame as the `not-loaded` kind of nothing. Opened, never closed on navigation: a person
 * who comes back finds the events that accumulated meanwhile. Everything closes with the window.
 */
export function useActiveSessionStore(
  registry: SessionStoreRegistry,
  activeSessionId: string | undefined,
): SessionStore | undefined {
  useEffect(() => {
    // On a remount this effect can run once with the registry that cleanup just disposed,
    // and `open` raises rather than returning a refusal.
    if (activeSessionId === undefined || registry.isDisposed) {
      return;
    }
    registry.open(activeSessionId);
  }, [registry, activeSessionId]);
  return useOpenSessionStore(registry, activeSessionId);
}
