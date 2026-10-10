import { useCallback, useSyncExternalStore } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { useOwnerWindow } from "./useOwnerWindow.js";

/**
 * The root font size of the window a component is drawn in, in CSS pixels. A `Text size` step
 * rewrites the root's inline style, so the size is read again on each change to that style, and a
 * caller re-renders only when the size itself changed.
 */
export function useRootFontSizePx(): number {
  const ownerWindow = useOwnerWindow();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const root = ownerWindow.document.documentElement;
      // The root's own window, whose observer belongs to the document it is in.
      const rootStyle = new (getWindow(root).MutationObserver)(onChange);
      rootStyle.observe(root, { attributes: true, attributeFilter: ["style"] });
      return () => {
        rootStyle.disconnect();
      };
    },
    [ownerWindow],
  );
  const readRootFontSizePx = useCallback(
    () =>
      Number.parseFloat(
        ownerWindow.getComputedStyle(ownerWindow.document.documentElement).fontSize,
      ),
    [ownerWindow],
  );
  return useSyncExternalStore(subscribe, readRootFontSizePx);
}
