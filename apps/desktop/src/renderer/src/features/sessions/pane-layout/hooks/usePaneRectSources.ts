import { useEffect } from "react";

import { observeElementResize } from "@renderer/lib/element-resize.js";
import { type PaneRectTracker } from "../pane-rect-tracker.js";

/**
 * Wires the host-resize, window-resize, ancestor-scroll and layout-mover sources to a tracker
 * while `container` is mounted.
 *
 * Scroll is listened for in the capture phase on the document because scroll events do not
 * bubble to the window. Passing the layout's revision counter as `layoutRevision` re-measures
 * on any width, order or density change.
 */
export function usePaneRectSources(
  tracker: PaneRectTracker,
  container: React.RefObject<HTMLElement | null>,
  layoutRevision: number,
): void {
  useEffect(() => {
    const element = container.current;
    if (element === null) {
      return;
    }
    // `observeElementResize` does nothing on a platform with no observer, so the window and
    // scroll sources below still fire.
    const releaseHostSizeSource = observeElementResize(element, () => {
      // A read, queued: mutating layout inside this callback would re-enter the observer.
      tracker.invalidate("host-resize");
    });

    const onWindowResize = (): void => {
      tracker.invalidate("window-resize");
    };
    const onAncestorScroll = (): void => {
      tracker.invalidate("ancestor-scroll");
    };
    window.addEventListener("resize", onWindowResize);
    document.addEventListener("scroll", onAncestorScroll, { capture: true, passive: true });

    return () => {
      releaseHostSizeSource();
      window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("scroll", onAncestorScroll, { capture: true });
    };
  }, [tracker, container]);

  useEffect(() => {
    tracker.invalidate("layout-mover");
  }, [tracker, layoutRevision]);
}
