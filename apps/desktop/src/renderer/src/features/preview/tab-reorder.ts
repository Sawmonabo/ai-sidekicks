// Dragging one tab to a new place. The drag payload rides a private MIME type, so a tab dropped
// into the composer or any page cannot paste a page id as text. `pageMoveIndex` holds the one
// piece of arithmetic that is easy to get wrong; `PageTabStrip.tsx` is its only caller.

/**
 * The drag type the preview's tab drags carry, and the only one they carry. Vendor-shaped
 * because the drag never leaves this window; the prefix avoids colliding with another feature's.
 */
export const PAGE_TAB_DRAG_MEDIA_TYPE = "application/x-meridian-preview-tab";

/**
 * Whether a drag carries this strip's type. Any other drag (a desktop file, a page link, a
 * transcript selection) is neither accepted nor prevented here.
 */
export function isTabDrag(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(PAGE_TAB_DRAG_MEDIA_TYPE);
}

/** Put a page's identity on a drag that is starting. */
export function writeTabDragPayload(transfer: DataTransfer, pageId: string): void {
  transfer.setData(PAGE_TAB_DRAG_MEDIA_TYPE, pageId);
  // `move`, not `copy`: a tab has one place, and the cursor should say so.
  transfer.effectAllowed = "move";
}

/**
 * Read the dragged page's identity back, or `undefined` where this drag is not a tab drag or the
 * payload is empty (an empty page id is one a caller could pass on by accident).
 */
export function readTabDragPayload(transfer: DataTransfer): string | undefined {
  if (!isTabDrag(transfer)) {
    return undefined;
  }
  const pageId = transfer.getData(PAGE_TAB_DRAG_MEDIA_TYPE);
  return pageId.length > 0 ? pageId : undefined;
}

/**
 * Translate a drop position among the drawn tabs into the registry's move index, or `undefined`
 * where the move is a no-op (dropped at its own position or right after it).
 *
 * A drop position counts among the tabs as drawn (`n + 1` slots, the dragged tab still in the
 * list), while a move index counts in the list with the dragged tab taken out. So a rightward
 * drop is `dropPosition - 1` and a leftward one is unchanged; a mistake moves the tab one place
 * short, in one direction only.
 */
export function pageMoveIndex(fromIndex: number, dropPosition: number): number | undefined {
  const moveIndex = dropPosition > fromIndex ? dropPosition - 1 : dropPosition;
  return moveIndex === fromIndex ? undefined : moveIndex;
}
