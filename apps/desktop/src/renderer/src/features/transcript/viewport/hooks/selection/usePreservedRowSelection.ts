// The React side of keeping a selection inside one row: the row's element goes to the viewport's
// selection tracker through a ref, and the restore runs after the row's commits, since a commit is
// the only moment a migration can have happened. One restore per row because a selection is kept
// in the coordinates of something that did not move, and the remount to survive is a block
// settling inside one row. A ref, not state: nothing renders from it. The layout effect has no
// dependency list for the same reason; a commit that migrated nothing finds no snapshot for this
// row, or the selection in place, and writes nothing.

import { useCallback, useLayoutEffect, useRef } from "react";

import { useViewportSelectionTracker } from "./useViewportSelectionTracker.js";

/** What a row attaches: a ref callback, and nothing it has to remember to call. */
export type RowSelectionAttach = (element: HTMLElement | null) => void;

/**
 * Preserve this row's selection across its own remounts. Returns the ref callback the row hands
 * its element to; attaching reads no selection.
 */
export function usePreservedRowSelection(): RowSelectionAttach {
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
        tracker.addRow(element);
        return;
      }
      const rowElement = rowElementRef.current;
      rowElementRef.current = undefined;
      if (rowElement !== undefined) {
        tracker.removeRow(rowElement);
      }
    },
    [tracker],
  );
}
