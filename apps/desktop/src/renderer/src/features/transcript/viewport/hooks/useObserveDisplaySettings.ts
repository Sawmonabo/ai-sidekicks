// The display a transcript's row heights are measured on: the screen's pixel ratio and the root
// font size. A `Text size` step rewrites the root's inline style and a window moved to another
// screen changes the ratio; either re-lays out every row, so the viewport is told and drops the
// heights it measured before.

import { getWindow } from "@floating-ui/utils/dom";
import { useEffect } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import type { ViewportController } from "../controller.js";

/** Tell `controller` the display its window draws on now, and again each time it changes. */
export function useObserveDisplaySettings(controller: ViewportController): void {
  const ownerWindow = useOwnerWindow();
  useEffect(() => {
    if (controller.isDisposed) {
      return undefined;
    }
    const root = ownerWindow.document.documentElement;
    // The root's own window, whose observer belongs to the document it is in.
    const rootWindow = getWindow(root);
    // A resolution query matches one ratio only, so each change re-arms it on the new one.
    let resolutionQuery: MediaQueryList | undefined;
    const observe = (): void => {
      controller.observeDisplaySettings(
        ownerWindow.devicePixelRatio,
        Number.parseFloat(ownerWindow.getComputedStyle(root).fontSize),
      );
      resolutionQuery?.removeEventListener("change", observe);
      resolutionQuery = ownerWindow.matchMedia(
        `(resolution: ${String(ownerWindow.devicePixelRatio)}dppx)`,
      );
      resolutionQuery.addEventListener("change", observe);
    };
    observe();
    const rootStyle = new rootWindow.MutationObserver(observe);
    rootStyle.observe(root, { attributes: true, attributeFilter: ["style"] });
    return () => {
      rootStyle.disconnect();
      resolutionQuery?.removeEventListener("change", observe);
    };
  }, [controller, ownerWindow]);
}
