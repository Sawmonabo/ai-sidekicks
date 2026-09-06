// Dragging one tab to a new place, and the one piece of arithmetic that is easy to
// get wrong.
//
// `Spec-023 §Console Design (Meridian)` 12.2: "Tab drag reorder carries the drag
// payload on a private MIME type and translates the drop index at the boundary: the
// registry's move index addresses the list WITHOUT the moved tab, so a tab dragged
// rightward targets `slot - 1`. The translation is stated once, at the one call site,
// never rediscovered per handler."
//
// So it is stated here, in one function, and `TabStrip.tsx` is the only module that
// calls it — which `test/console/architecture/tab-reorder-single-site.test.ts` holds
// rather than leaving to review. The two facts that make the subtraction necessary
// are worth writing down, because a reader who has only one of them will delete it:
//
//   • A DROP SLOT is a position among the tabs AS DRAWN. There are `n + 1` of them
//     for `n` tabs — before the first, between each pair, and after the last — and
//     the dragged tab is still one of the `n` while it is being dragged.
//   • A MOVE INDEX is a position in the list with the moved page taken OUT of it.
//     That list has `n - 1` entries, so every slot to the right of the tab's own
//     position names a place one further along than it looks.
//
// Rightward is therefore `slot - 1` and leftward is `slot` unchanged. Getting it
// wrong is not a crash: it moves the tab one place short of where the person dropped
// it, every time, in one direction only — which is the kind of defect that survives a
// demo and is reported months later as "reordering feels off".
//
// WHY THE PAYLOAD IS A PRIVATE MIME TYPE. A drag carrying `text/plain` is a drag any
// page, any editor, and any other drop target in the window will happily accept, and
// a tab dropped into the composer would paste a page id as text. The private type is
// read by this family and nothing else, so a drag that leaves the strip lands nowhere.

/**
 * The drag type this family's tab drags carry, and the only one they carry.
 *
 * A vendor-shaped string rather than a registered one: the drag never leaves this
 * window, so there is nothing to register it with, and the prefix is what stops it
 * colliding with a type some other surface invents.
 */
export const BROWSER_TAB_DRAG_MEDIA_TYPE = "application/x-meridian-browser-tab";

/**
 * What a drag over the strip may do, read off the drag itself.
 *
 * A drag carrying anything else is not this strip's — a file from the desktop, a link
 * from a page, a selection from the timeline — and the strip neither accepts it nor
 * prevents whatever else in the window would.
 */
export function isTabDrag(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes(BROWSER_TAB_DRAG_MEDIA_TYPE);
}

/** Put a page's identity on a drag that is starting. */
export function writeTabDragPayload(transfer: DataTransfer, pageId: string): void {
  transfer.setData(BROWSER_TAB_DRAG_MEDIA_TYPE, pageId);
  // `move` and not `copy`: a tab has one place and dropping it makes a new one, which
  // is what the cursor should say while the drag is in the air.
  transfer.effectAllowed = "move";
}

/**
 * Read the dragged page's identity back, or nothing where this drag is not one.
 *
 * `undefined` rather than the empty string a `DataTransfer` hands back for an absent
 * type: an empty page id is a value a caller can pass on by accident, and a missing
 * one is not.
 */
export function readTabDragPayload(transfer: DataTransfer): string | undefined {
  if (!isTabDrag(transfer)) {
    return undefined;
  }
  const pageId = transfer.getData(BROWSER_TAB_DRAG_MEDIA_TYPE);
  return pageId.length > 0 ? pageId : undefined;
}

/**
 * Translate a drop slot among the drawn tabs into the registry's move index.
 *
 * The one statement of the rule the header explains. Returns `undefined` where the
 * move is a no-op — a tab dropped in its own slot, or in the slot immediately after
 * itself, both of which name the position it already occupies — so the caller sends
 * nothing rather than dispatching an act that would answer "moved" for a move that
 * did not happen.
 */
export function pageMoveIndex(fromIndex: number, dropSlot: number): number | undefined {
  const moveIndex = dropSlot > fromIndex ? dropSlot - 1 : dropSlot;
  return moveIndex === fromIndex ? undefined : moveIndex;
}
