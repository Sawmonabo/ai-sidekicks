import { useEffect } from "react";

import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { type Announce } from "@renderer/components/LiveAnnouncer/live-announcer.js";
import {
  commitPaneDrop,
  paneIdFromDragData,
  type PaneLayoutDragCoordinator,
} from "../pane-drag.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";

/**
 * Commit the drop, once, for the whole pane layout. One monitor rather than an `onDrop` per
 * target, because the outcome depends on the indicator the coordinator holds, and the monitor
 * also runs for a drag that ends over nothing, which must clear the indicator and be said out
 * loud through `announce` (the window's announcer).
 */
export function usePaneLayoutDragMonitor(
  coordinator: PaneLayoutDragCoordinator,
  layout: PaneLayoutStore,
  announce: Announce,
): void {
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => paneIdFromDragData(source.data) !== undefined,
        onDrop: ({ source }) => {
          const draggedPaneId = paneIdFromDragData(source.data);
          const indicator = coordinator.snapshot();
          coordinator.clear();
          commitPaneDrop(layout, draggedPaneId, indicator, announce);
        },
      }),
    [announce, coordinator, layout],
  );
}
