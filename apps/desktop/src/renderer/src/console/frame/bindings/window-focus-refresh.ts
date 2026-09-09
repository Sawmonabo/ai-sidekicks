// Window focus as a refresh REASON, bound once per window.
//
// `Spec-023 §Rules every console surface obeys` admits a small closed set of reasons a
// reading may be taken again and forbids interval polling; this module owns one of
// them for the whole window, so no surface arms a listener of its own to get it.
//
// THE RE-READ RIDES THE TRANSITION INTO FOCUS RATHER THAN THE EVENT ITSELF. A window
// that never lost focus missed nothing, so re-reading every open session on a focus
// event a person did not cause would be the poll this design refuses; a window that
// WAS blurred may have missed a delivery or a read while nobody was looking, and its
// open stores are stale until something asks for them again.
//
// WHETHER THE WINDOW WAS FOCUSED IS READ BACK FROM THE STORE rather than kept in a ref
// beside it. The store already holds that fact — `isWindowFocused` is what the
// scheduler's `window-focus` reason is named for — and a second copy would be the same
// value recorded twice, free to disagree.
//
// It is the frame's binding and not a view family's for the reason the frame's other
// window-lifetime bindings are: it is armed once, for as long as the window holds a
// bridge, and a listener mounted by a destination would stop hearing the transition the
// moment a person navigated away.

import { useEffect } from "react";

import type { FrameStore, SessionStoreRegistry } from "../../store/index.js";

/**
 * Arm this window's focus transition for the frame's lifetime.
 *
 * Both edges are bound together because the blurred edge is what makes the focused one
 * a transition: the listener that records the blur is the only thing that can tell a
 * window coming back from one that never left.
 */
export function useWindowFocusRefresh(
  frameStore: FrameStore,
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
