import { useEffect, useState } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { PANE_LAYOUT_DRAG_KEY, type PaneLayoutDragCoordinator } from "../pane-drag.js";

/**
 * Make one pane's header the handle that drags its pane.
 *
 * The header and not the whole pane: a pane body holds text a person selects and
 * controls they click, and a draggable ancestor turns every one of those into the
 * start of a drag. The header is the strip that means "this pane", which is what
 * makes it the handle in every deck a person has used.
 */
export function usePaneDragSource(
  coordinator: PaneLayoutDragCoordinator,
  paneId: string,
): (element: HTMLElement | null) => void {
  const [handle, setHandle] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (handle === null) {
      return;
    }
    return draggable({
      element: handle,
      getInitialData: () => ({ [PANE_LAYOUT_DRAG_KEY]: paneId }),
      onDragStart: () => {
        coordinator.startDrag(paneId);
      },
    });
  }, [coordinator, handle, paneId]);

  return setHandle;
}
