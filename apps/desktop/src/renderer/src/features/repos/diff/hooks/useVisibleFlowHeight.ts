import { useLayoutEffect, useState } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { nearestVerticalScrollerOf } from "#renderer/lib/clipping-ancestors.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";

/**
 * The height of the flow an element is drawn in, in CSS pixels: the client height of the nearest
 * ancestor the person scrolls vertically, or of the window where none does. Follows that box as
 * it is resized; `undefined` until the element is mounted.
 */
export function useVisibleFlowHeight(element: HTMLElement | null): number | undefined {
  const [heightPx, setHeightPx] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (element === null) {
      return undefined;
    }
    const ownerWindow = getWindow(element);
    const scroller = nearestVerticalScrollerOf(element);
    if (scroller === undefined) {
      const readWindow = (): void => {
        setHeightPx(ownerWindow.innerHeight);
      };
      readWindow();
      ownerWindow.addEventListener("resize", readWindow);
      return () => {
        ownerWindow.removeEventListener("resize", readWindow);
      };
    }
    setHeightPx(scroller.clientHeight);
    return observeElementResize(scroller, () => {
      setHeightPx(scroller.clientHeight);
    });
  }, [element]);

  return heightPx;
}
