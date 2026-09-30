import { useEffect, useRef, useState } from "react";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { type Clock } from "@renderer/lib/clock.js";
import { PaneRectTracker } from "../pane-rect-tracker.js";
import { type TrackedRect } from "../pane-rect-geometry.js";

/**
 * Holds one rect tracker for the lifetime of the component that owns the panes.
 *
 * The sink lives in a ref, so an inline `onRects` does not rebuild the tracker and reset its
 * dedupe memory every render.
 */
export function usePaneRectTracker(options: {
  readonly clock: Clock;
  readonly onRects?: (rects: readonly TrackedRect[]) => void;
}): PaneRectTracker {
  const sink = useRef(options.onRects);
  useEffect(() => {
    sink.current = options.onRects;
  }, [options.onRects]);

  const [tracker] = useState(
    () =>
      new PaneRectTracker({
        clock: options.clock,
        onFlush: (rects) => sink.current?.(rects),
        // Taken from the document, not a prop: overlays register on their own document's
        // registry.
        airspace: airspaceRegistryFor(document),
      }),
  );

  useEffect(
    () => () => {
      tracker.dispose();
    },
    [tracker],
  );
  return tracker;
}
