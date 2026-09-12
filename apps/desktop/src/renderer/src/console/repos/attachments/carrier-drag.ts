// One carrier row's drag gesture: what the library is asked for, and what stays ours.
//
// THE LIBRARY IS THE ADOPTED ONE AND ONLY FOR THE GESTURE.
// `@atlaskit/pragmatic-drag-and-drop` is admitted at an exact pin for drag, with the
// drop indicators, the keyboard path, and the live-region strings ours. So this module
// registers a draggable and a drop target through the
// library's own direct entry paths — never the deprecated shims the 3.x line kept — and
// answers exactly two questions with its own state: whether this row is the one being
// dragged, and whether a droppable row is over it. Where the drop LANDS is
// `attachment-reorder.ts`, which the keyboard path calls too.
//
// THE DRAG DATA IS A LOCAL ID AND NOTHING ELSE. `getInitialData` runs once as the drag
// starts, so anything richer put in it would be a snapshot of an entry that can settle,
// be refused, or be abandoned before the drop — and the drop would then move a row the
// participant is no longer looking at. One opaque string, re-read against the ledger by
// whoever performs the move.
//
// A ROW NEVER ACCEPTS ITSELF. `canDrop` refuses the source row, so a drag that ends
// where it began performs no move and announces nothing — the alternative is a live
// region saying "moved to position 3 of 4" about an attachment that did not move.
//
// THE WHOLE ROW IS THE DRAGGABLE AND THE HANDLE IS THE GRIP. The library takes both:
// the element is what a browser drags a preview of, and the handle is the only part a
// press may start from. Making the row itself the grip would swallow text selection
// inside the card, and making the handle the draggable would drag a button-sized
// preview of a row-sized thing.

import { useEffect, useState } from "react";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";

import { useLatestRef } from "../../primitives/index.js";

/**
 * The key the dragged attachment's local id travels under.
 *
 * A plain string because the library types drag data as `Record<string, unknown>`, and
 * one constant because the producer and the reader are two halves of one seam — two
 * spellings would type-check and silently never match.
 */
const ATTACHMENT_DRAG_DATA_KEY = "attachmentLocalId";

export interface CarrierRowDragOptions {
  /** The attachment this row stands for. */
  readonly localId: string;
  /** The row element — what is dragged. `null` until the row commits. */
  readonly rowElement: HTMLElement | null;
  /** The grip inside it — the only part a drag may start from. */
  readonly handleElement: HTMLElement | null;
  /** Move the dragged attachment to this row's position. */
  readonly onDropOnto: (draggedLocalId: string, targetLocalId: string) => void;
}

/** What the row renders differently while a drag is in flight. */
export interface CarrierRowDragState {
  readonly isDragging: boolean;
  readonly isDropTarget: boolean;
}

/**
 * Bind one row to the drag adapter for as long as it is mounted.
 *
 * THE CALLBACK IS READ AT INVOKE TIME rather than captured, through the console's own
 * `useLatestRef`: a drop handler is built once and fires much later, and an effect that
 * re-bound whenever the handler's identity changed would tear the registration down and
 * rebuild it on every render of the list above it — during a drag, that is the drop
 * target disappearing under the pointer.
 */
export function useCarrierRowDrag(options: CarrierRowDragOptions): CarrierRowDragState {
  const { localId, rowElement, handleElement } = options;
  const onDropOnto = useLatestRef(options.onDropOnto);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);

  useEffect(() => {
    if (rowElement === null || handleElement === null) {
      return undefined;
    }
    return combine(
      draggable({
        element: rowElement,
        dragHandle: handleElement,
        getInitialData: () => ({ [ATTACHMENT_DRAG_DATA_KEY]: localId }),
        onDragStart: () => {
          setIsDragging(true);
        },
        onDrop: () => {
          setIsDragging(false);
        },
      }),
      dropTargetForElements({
        element: rowElement,
        canDrop: ({ source }) => {
          const dragged = draggedAttachmentLocalId(source.data);
          return dragged !== undefined && dragged !== localId;
        },
        onDragEnter: () => {
          setIsDropTarget(true);
        },
        onDragLeave: () => {
          setIsDropTarget(false);
        },
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const dragged = draggedAttachmentLocalId(source.data);
          if (dragged !== undefined) {
            onDropOnto.current(dragged, localId);
          }
        },
      }),
    );
  }, [localId, rowElement, handleElement, onDropOnto]);

  return { isDragging, isDropTarget };
}

/** The local id a drag is carrying, or `undefined` when the payload is not ours. */
function draggedAttachmentLocalId(data: Record<string | symbol, unknown>): string | undefined {
  const carried = data[ATTACHMENT_DRAG_DATA_KEY];
  return typeof carried === "string" ? carried : undefined;
}
