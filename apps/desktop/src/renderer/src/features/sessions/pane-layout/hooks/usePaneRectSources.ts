import { useEffect } from "react";

import { observeElementResize } from "@renderer/console/primitives/index.js";
import { type PaneRectTracker } from "../pane-rect-tracker.js";

/**
 * Wire the four invalidation sources to a tracker, for as long as `container` is
 * mounted.
 *
 * All four in ONE effect, because they are one subscription to one question — "has
 * anything moved?" — and splitting them across effects would make the teardown
 * order decide whether a listener outlives the observer it was installed beside.
 *
 * Scroll is listened for in the CAPTURE phase on the document: a scroll inside any
 * ancestor of a pane moves that pane on screen, and scroll events do not bubble
 * from an element to the window, so a bubble-phase window listener would miss every
 * one that mattered.
 *
 * `layoutRevision` is the fourth source — the layout movers. Passing the layout's
 * own revision counter means a pane width change, a reorder, and a density change
 * all re-measure without this module having to know what any of them are.
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
    // Through the console's one size-observer site rather than a second construction:
    // `primitives/element-resize.ts` owns the feature detection and the teardown, and
    // its degrade is what makes the guard above an element test alone — a platform
    // with no observer arms nothing THERE while the window and scroll sources below
    // still fire, where the construction this replaced returned before arming any of
    // the four and left a pane's rect answering from a measurement nothing refreshed.
    const releaseHostSizeSource = observeElementResize(element, () => {
      // A READ, queued. Mutating layout from inside this callback re-enters the
      // observer, which is the loop this module's rule 1 forbids.
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
