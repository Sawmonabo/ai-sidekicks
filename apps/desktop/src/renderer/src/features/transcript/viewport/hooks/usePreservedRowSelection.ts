// The React binding for the row selection guard: one guard per mounted row, attached through
// a ref. `selection-preservation.ts` holds the mechanism; this holds the React side, since the
// restore must run after a commit. One per row because a selection is preserved in the
// coordinates of something that did not move, and the remount to survive is a block settling
// inside one row. A ref, not state: the guard renders nothing. The layout effect has no
// dependency list because a commit is the only moment a migration can have happened; a commit
// that migrated nothing finds the selection in place and writes nothing.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { RowSelectionGuard } from "../selection-preservation.js";

/** What a row attaches: a ref callback, and nothing it has to remember to call. */
export type RowSelectionAttach = (element: HTMLElement | null) => void;

/**
 * Preserve this row's selection across its own remounts. Returns the ref callback the row
 * hands its element to; the guard is created on the first element, so a row that never
 * paints installs no listener.
 */
export function usePreservedRowSelection(): RowSelectionAttach {
  const guardRef = useRef<RowSelectionGuard | undefined>(undefined);

  useEffect(
    () => () => {
      guardRef.current?.dispose();
      guardRef.current = undefined;
    },
    [],
  );

  useLayoutEffect(() => {
    const guard = guardRef.current;
    if (guard !== undefined) {
      // Before paint, so the reader never sees a frame with the selection gone.
      guard.restoreAfterFlush(guard.generation);
    }
  });

  return useCallback((element: HTMLElement | null): void => {
    if (element === null) {
      guardRef.current?.observe(null);
      return;
    }
    const existing = guardRef.current;
    if (existing !== undefined) {
      existing.observe(element);
      return;
    }
    const guard = new RowSelectionGuard(element.ownerDocument);
    guard.observe(element);
    guardRef.current = guard;
  }, []);
}
