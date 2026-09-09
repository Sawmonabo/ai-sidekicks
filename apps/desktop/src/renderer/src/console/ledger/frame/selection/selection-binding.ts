// The React binding for the row selection guard: one guard per mounted row, and the
// ref a row attaches it through.
//
// `selection-preservation.ts` holds the mechanism — the offsets, the listener, the
// restore rule. This module holds the React side of it, on `reveal-binding.ts`' split
// and for the same reason: the guard listens to a document and knows nothing about
// renders, and the restore has to happen after a commit, which only the tree can say.
//
// ONE PER ROW, AND WHY THAT IS THE RIGHT SCOPE. The remount a selection has to survive
// is a BLOCK settling inside one row, and a selection is preserved by addressing it in
// the coordinates of something that did not move — which is the row. A guard per feed
// would have to hold the whole log's coordinates and re-derive which row moved; a
// guard per block would lose exactly the selections that span a block boundary, which
// are the ones a migration breaks.
//
// WHY A REF AND NOT STATE. The guard's identity never renders anything: the tree is
// unchanged by which guard a row holds, and putting it in state would cost every row
// an extra render at mount for a value nothing displays.
//
// WHY A LAYOUT EFFECT WITH NO DEPENDENCY LIST. The restore has to run after every
// commit of the row, because a commit is the only moment a migration can have
// happened. The guard's own four refusals are what keep that cheap and safe: a commit
// that migrated nothing finds the selection still in place and writes nothing.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { RowSelectionGuard, type SelectionDocument } from "./selection-preservation.js";

/** What a row attaches: a ref callback, and nothing it has to remember to call. */
export type RowSelectionAttach = (element: HTMLElement | null) => void;

/**
 * Preserve this row's selection across its own remounts.
 *
 * Returns the ref callback the row hands its element to. The guard is minted lazily,
 * on the first element, because a row that never paints installs no listener.
 */
export function useRowSelectionPreservation(): RowSelectionAttach {
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
      // Before paint, deliberately: a restore after one would show the reader a frame
      // with their selection gone and then put it back, which is the flicker the
      // whole guard exists to remove.
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
    const selectionDocument = ownerDocumentOf(element);
    if (selectionDocument === undefined) {
      return;
    }
    const guard = new RowSelectionGuard(selectionDocument);
    guard.observe(element);
    guardRef.current = guard;
  }, []);
}

/**
 * The document this row lives in.
 *
 * Reached through the element rather than a module-scope binding, so no module-level
 * value is minted and a test drives the same code path with a document it controls.
 */
function ownerDocumentOf(element: HTMLElement): SelectionDocument | undefined {
  return (element.ownerDocument ?? undefined) as SelectionDocument | undefined;
}
