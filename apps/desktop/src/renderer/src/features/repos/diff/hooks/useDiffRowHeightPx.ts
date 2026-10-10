import { useCallback, useSyncExternalStore } from "react";

import { getWindow } from "@floating-ui/utils/dom";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { DIFF_ROW_HEIGHT_REM } from "../measures.js";

/**
 * One diff row's height at the current `Text size`, in CSS pixels: the row's rem height at the
 * root font size of the window the rows are drawn in. A `Text size` step rewrites the root's
 * inline style, so the height is read again on each change to that style.
 */
export function useDiffRowHeightPx(): number {
  const ownerWindow = useOwnerWindow();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const root = ownerWindow.document.documentElement;
      // The root's own window, whose observer belongs to the document it is in.
      const rootStyle = new (getWindow(root).MutationObserver)(onChange);
      rootStyle.observe(root, {
        attributes: true,
        attributeFilter: ["style"],
      });
      return () => {
        rootStyle.disconnect();
      };
    },
    [ownerWindow],
  );
  const readRowHeightPx = useCallback(
    () =>
      DIFF_ROW_HEIGHT_REM *
      Number.parseFloat(
        ownerWindow.getComputedStyle(ownerWindow.document.documentElement).fontSize,
      ),
    [ownerWindow],
  );
  return useSyncExternalStore(subscribe, readRowHeightPx);
}
