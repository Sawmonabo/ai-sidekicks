import { useContext } from "react";

import { ViewportSelectionTrackerContext } from "../../selection/context.js";
import { type ViewportSelectionTracker } from "../../selection/tracker.js";

/**
 * The selection tracker of the transcript viewport this component renders in.
 *
 * Throws outside a viewport rather than answering with a stub: a row that silently loses the
 * reader's selection on every flush looks like a browser quirk, not a missing provider.
 */
export function useViewportSelectionTracker(): ViewportSelectionTracker {
  const tracker = useContext(ViewportSelectionTrackerContext);
  if (tracker === undefined) {
    throw new Error("a transcript row was mounted outside a transcript viewport");
  }
  return tracker;
}
