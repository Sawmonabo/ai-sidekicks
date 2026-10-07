import { useCallback, useState } from "react";

import { ViewportSelectionTracker } from "../../selection/tracker.js";

/** What the viewport renders with: the tracker its rows read, and its scroll container's ref. */
export interface ViewportSelectionBinding {
  readonly tracker: ViewportSelectionTracker;
  /** The scroll container's ref: the caller's own ref, then the tracker's attach. */
  readonly attachScrollContainer: (element: HTMLElement | null) => void;
}

/**
 * Creates one viewport's selection tracker and attaches it with the scroll container, so the
 * viewport's one `selectionchange` listener lives exactly as long as its scroller.
 */
export function useTrackViewportSelection(
  attachScrollContainer: (element: HTMLElement | null) => void,
): ViewportSelectionBinding {
  const [tracker] = useState(() => new ViewportSelectionTracker());
  const attachTrackedScrollContainer = useCallback(
    (element: HTMLElement | null): void => {
      attachScrollContainer(element);
      if (element === null) {
        tracker.detach();
        return;
      }
      tracker.attach(element);
    },
    [attachScrollContainer, tracker],
  );
  return { tracker, attachScrollContainer: attachTrackedScrollContainer };
}
