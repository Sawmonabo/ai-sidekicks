import { useLayoutEffect, useState } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import {
  SCROLLING_OVERFLOW_VALUES,
  clippingAncestorsOf,
  overflowAxesOf,
} from "#renderer/lib/clipping-ancestors.js";
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
    const scroller = verticalScrollerOf(element);
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

/** The nearest ancestor whose vertical overflow the person scrolls, innermost first. */
function verticalScrollerOf(element: HTMLElement): HTMLElement | undefined {
  const ownerWindow = getWindow(element);
  for (const ancestor of clippingAncestorsOf(element)) {
    const { vertical } = overflowAxesOf(ownerWindow.getComputedStyle(ancestor));
    if (SCROLLING_OVERFLOW_VALUES.some((value) => value === vertical)) {
      return ancestor;
    }
  }
  return undefined;
}
