import { useCallback, useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import type { Unsubscribe } from "#shared/preload-api.js";
import { nearestVerticalScrollerOf } from "#renderer/lib/clipping-ancestors.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { TranscriptBodyViewportContext } from "../context.js";

/**
 * The height of the flow `element` is drawn in, in CSS pixels. Inside a transcript viewport it is
 * the scroll controller's published height, `undefined` before its first sample, and a scroll
 * draws nothing again; elsewhere it is the client height of the element's nearest vertical
 * scroller, or of the window where none scrolls, followed as it resizes, and `undefined` while
 * `element` is null.
 */
export function useVisibleFlowHeight(element: HTMLElement | null): number | undefined {
  const scrollController = useContext(TranscriptBodyViewportContext)?.scrollController;
  const subscribe = useCallback(
    (onChange: () => void): Unsubscribe =>
      scrollController === undefined
        ? () => undefined
        : scrollController.subscribeToGeometry(onChange),
    [scrollController],
  );
  const viewportHeightPx = useSyncExternalStore(
    subscribe,
    () => scrollController?.geometry?.viewportHeight,
  );
  const [scrollerHeightPx, setScrollerHeightPx] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (scrollController !== undefined || element === null) {
      return undefined;
    }
    const ownerWindow = getWindow(element);
    const scroller = nearestVerticalScrollerOf(element);
    if (scroller === undefined) {
      const readWindow = (): void => {
        setScrollerHeightPx(ownerWindow.innerHeight);
      };
      readWindow();
      ownerWindow.addEventListener("resize", readWindow);
      return () => {
        ownerWindow.removeEventListener("resize", readWindow);
      };
    }
    setScrollerHeightPx(scroller.clientHeight);
    return observeElementResize(scroller, () => {
      setScrollerHeightPx(scroller.clientHeight);
    });
  }, [scrollController, element]);

  if (scrollController !== undefined) {
    return viewportHeightPx === 0 ? undefined : viewportHeightPx;
  }
  return element === null ? undefined : scrollerHeightPx;
}
