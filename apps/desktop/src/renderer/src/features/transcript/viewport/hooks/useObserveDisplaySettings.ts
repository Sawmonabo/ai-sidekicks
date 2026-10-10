// The display a transcript's row heights are measured on: the screen's pixel ratio and the root
// font size. A `Text size` step changes the root font size and a window moved to another screen
// changes the ratio; either re-lays out every row, so the viewport is told and drops the heights
// it measured before.

import { useEffect } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useRootFontSizePx } from "#renderer/hooks/useRootFontSizePx.js";
import type { ViewportController } from "../controller.js";

/** Tell `controller` the display its window draws on now, and again each time it changes. */
export function useObserveDisplaySettings(controller: ViewportController): void {
  const ownerWindow = useOwnerWindow();
  const rootFontSizePx = useRootFontSizePx();
  useEffect(() => {
    if (controller.isDisposed) {
      return undefined;
    }
    // A resolution query matches one ratio only, so each change re-arms it on the new one.
    let resolutionQuery: MediaQueryList | undefined;
    const observe = (): void => {
      controller.observeDisplaySettings(ownerWindow.devicePixelRatio, rootFontSizePx);
      resolutionQuery?.removeEventListener("change", observe);
      resolutionQuery = ownerWindow.matchMedia(
        `(resolution: ${String(ownerWindow.devicePixelRatio)}dppx)`,
      );
      resolutionQuery.addEventListener("change", observe);
    };
    observe();
    return () => {
      resolutionQuery?.removeEventListener("change", observe);
    };
  }, [controller, ownerWindow, rootFontSizePx]);
}
