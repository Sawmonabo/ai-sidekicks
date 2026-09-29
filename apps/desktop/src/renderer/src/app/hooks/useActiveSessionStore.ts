// The store for the session the route names, opened from an effect.
//
// Two rules decide the shape, and both are about the render phase:
//
//   • **No component constructs a store.** A component RESOLVES one through
//     `useOpenSessionStore`, which is a read. Nothing here calls `open` during
//     render: the open rides an effect keyed on the session the route names, so a
//     render pass React discards cannot leave a session open that nothing closes.
//     This replaced a `Map` held in a ref whose misses constructed a store inside
//     the render body, where a discarded pass took every event applied to it too.
//   • **`undefined` is an answer, not a cue.** Between the render that first names
//     a session and the effect that opens it there is one frame with no store. The
//     honest render of that frame is the `not-loaded` kind of nothing — a read is
//     in flight — and `RouteSurface` renders exactly that. Opening the session from
//     inside render to skip the frame is the defect, not the fix.

import { useEffect } from "react";

import { useOpenSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import type { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";

/**
 * The store for the session the route names, or `undefined` while it is opening.
 *
 * Opened, never closed on navigation: a person who leaves a session and comes back
 * finds the events it accumulated while they were away, which is what the
 * never-evicting map this replaced also gave them. Everything closes together when
 * the window does.
 */
export function useActiveSessionStore(
  registry: SessionStoreRegistry,
  activeSessionId: string | undefined,
): SessionStore | undefined {
  useEffect(() => {
    // The disposed check is the remount window `useSessionStoreRegistry` re-mints in:
    // this effect can run once with the registry that cleanup just disposed, and
    // `open` is the one registry call that raises rather than returning a refusal.
    if (activeSessionId === undefined || registry.isDisposed) {
      return;
    }
    registry.open(activeSessionId);
  }, [registry, activeSessionId]);
  return useOpenSessionStore(registry, activeSessionId);
}
