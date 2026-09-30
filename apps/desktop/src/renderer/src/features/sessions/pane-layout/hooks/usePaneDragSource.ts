import { useEffect, useState } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { PANE_LAYOUT_DRAG_KEY, type PaneLayoutDragCoordinator } from "../pane-drag.js";

/**
 * Make one pane's header the handle that drags its pane. The header and not the whole pane,
 * because a draggable ancestor turns every text selection and control click in the body into
 * the start of a drag.
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
