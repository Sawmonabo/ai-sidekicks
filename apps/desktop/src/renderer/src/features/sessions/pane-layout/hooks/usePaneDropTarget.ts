import { useEffect } from "react";

import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import {
  PANE_LAYOUT_DRAG_KEY,
  dropEdgeFor,
  paneIdFromDragData,
  type PaneLayoutDragCoordinator,
} from "../pane-drag.js";

/**
 * Make one pane a place a dragged pane can land. The target is the pane's root element, so
 * the whole column is a target and the edge is decided by the pointer's position within it.
 */
export function usePaneDropTarget(
  coordinator: PaneLayoutDragCoordinator,
  paneId: string,
  element: HTMLElement | null,
): void {
  useEffect(() => {
    if (element === null) {
      return;
    }
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const draggedPaneId = paneIdFromDragData(source.data);
        return draggedPaneId !== undefined && draggedPaneId !== paneId;
      },
      getData: () => ({ [PANE_LAYOUT_DRAG_KEY]: paneId }),
      onDrag: ({ location }) => {
        coordinator.hover({
          overPaneId: paneId,
          edge: dropEdgeFor(element, location.current.input.clientX),
        });
      },
      onDragLeave: () => {
        coordinator.clear();
      },
    });
  }, [coordinator, element, paneId]);
}
