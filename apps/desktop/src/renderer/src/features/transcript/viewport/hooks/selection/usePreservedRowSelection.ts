// The React side of keeping the reader's selection across a row's remounts: the row's element goes
// to the viewport's selection tracker under its key through a ref, and the restore runs after the
// row's commits, since a commit is the only moment a block can have settled inside the row or the
// row come back into the window. A ref, not state: nothing renders from it. The layout effect has
// no dependency list for the same reason; a commit that moved nothing finds the selection in place,
// or none to keep, and writes nothing.

import { useCallback, useLayoutEffect, useRef } from "react";

import { useViewportSelectionTracker } from "./useViewportSelectionTracker.js";

/** What a row attaches: a ref callback, and nothing it has to remember to call. */
export type RowSelectionAttach = (element: HTMLElement | null) => void;

/**
 * Preserve the selection in the row under `rowKey` across its own remounts. Returns the ref
 * callback the row hands its element to; attaching reads no selection.
 */
export function usePreservedRowSelection(rowKey: string): RowSelectionAttach {
  const tracker = useViewportSelectionTracker();
  const rowElementRef = useRef<HTMLElement | undefined>(undefined);

  useLayoutEffect(() => {
    const rowElement = rowElementRef.current;
    if (rowElement !== undefined) {
      // Before paint, so the reader never sees a frame with the selection gone.
      tracker.restoreAfterFlush(rowElement);
    }
  });

  return useCallback(
    (element: HTMLElement | null): void => {
      if (element !== null) {
        rowElementRef.current = element;
        tracker.addRow(element, rowKey);
        return;
      }
      const rowElement = rowElementRef.current;
      rowElementRef.current = undefined;
      if (rowElement !== undefined) {
        tracker.removeRow(rowElement);
      }
    },
    [tracker, rowKey],
  );
}
