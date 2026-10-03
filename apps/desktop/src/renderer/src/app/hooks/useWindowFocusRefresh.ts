// Window focus as a refresh reason, bound once per window so no view arms a listener of its own.
//
// The re-read rides the transition into focus, not the event: a window that never lost focus
// missed nothing, and re-reading on every focus event would be the poll this design refuses.
// The store's `isWindowFocused` holds whether the window was focused, so no second copy is kept.
// A destination's listener would stop hearing the transition once a person navigated away.

import { useEffect } from "react";

import type { WindowStore } from "@renderer/store/window/window-store.js";
import type { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";

/**
 * Arm this window's focus transition for the frame's lifetime.
 *
 * Both edges are bound together: the blur is what makes a focus a transition worth a re-read.
 */
export function useWindowFocusRefresh(
  frameStore: WindowStore,
  sessionStoreRegistry: SessionStoreRegistry,
): void {
  useEffect(() => {
    const onFocus = (): void => {
      if (frameStore.getState().isWindowFocused) {
        return;
      }
      frameStore.setWindowFocused(true);
      sessionStoreRegistry.requestRefreshOfEverySession("window-focus");
    };
    const onBlur = (): void => {
      frameStore.setWindowFocused(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [frameStore, sessionStoreRegistry]);
}
