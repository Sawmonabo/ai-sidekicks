import { useEffect } from "react";

import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { type Announce } from "@renderer/console/primitives/index.js";
import {
  commitPaneDrop,
  paneIdFromDragData,
  type PaneLayoutDragCoordinator,
} from "../pane-drag.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";

/**
 * Commit the drop, once, for the whole deck.
 *
 * ONE monitor rather than an `onDrop` per target, because the outcome depends on
 * the indicator the coordinator holds — which target the pointer settled on and
 * which edge — and a per-target handler would each have to re-derive it. The
 * monitor also runs for a drag that ends over nothing, which is the case that has
 * to clear the indicator and commit nothing; a per-target handler never fires there
 * at all. That case is also the one a person gets no feedback from unless it is
 * SAID — the deck looks the same as it did — so it reaches `commitPaneDrop` like
 * every other drop rather than returning early.
 *
 * @param announce The window's announcer, read from the context by the deck.
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
