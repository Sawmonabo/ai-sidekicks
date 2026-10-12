// The transcript's follow of the bottom held while a person drags one of the session view's pane
// edges: the conversation narrows or widens under the hand, and a chunk arriving mid-drag must
// not pull the text away. The follow resumes on release.

import { useContext, useEffect } from "react";

import { PaneEdgeDragContext } from "#renderer/components/PaneEdge/drag-context.js";
import type { ViewportController } from "../controller.js";

/** Holds `controller`'s follow for as long as a pane edge around it is dragged. */
export function useHoldFollowWhilePaneEdgeDragged(controller: ViewportController): void {
  const isPaneEdgeDragged = useContext(PaneEdgeDragContext);
  useEffect(
    () => (isPaneEdgeDragged ? controller.holdFollow() : undefined),
    [controller, isPaneEdgeDragged],
  );
}
