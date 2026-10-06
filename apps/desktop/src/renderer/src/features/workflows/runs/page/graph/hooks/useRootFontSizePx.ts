import { getWindow } from "@floating-ui/utils/dom";
import { useCallback, useSyncExternalStore } from "react";

import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";

/**
 * The root font size of the window this component is drawn in, in CSS pixels. The appearance
 * writes the person's text size onto the root element's inline style, so a change to that
 * attribute is the one moment it is read again.
 */
export function useRootFontSizePx(): number {
  const root = useOwnerWindow().document.documentElement;
  // The root's own window, whose observer and styles belong to the document it is in.
  const ownerWindow = getWindow(root);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const observer = new ownerWindow.MutationObserver(onChange);
      observer.observe(root, { attributes: true, attributeFilter: ["style"] });
      return () => {
        observer.disconnect();
      };
    },
    [ownerWindow, root],
  );
  const read = useCallback(
    () => Number.parseFloat(ownerWindow.getComputedStyle(root).fontSize),
    [ownerWindow, root],
  );
  return useSyncExternalStore(subscribe, read);
}
