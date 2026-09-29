import { useEffect, useRef, useState } from "react";

import { airspaceRegistryFor } from "@renderer/lib/airspace-registries.js";
import { type Clock } from "@renderer/lib/clock.js";
import { PaneRectTracker } from "../pane-rect-tracker.js";
import { type TrackedRect } from "../pane-rect-geometry.js";

/**
 * Hold one tracker for the lifetime of the component that owns the panes.
 *
 * The sink is held in a ref and updated in an effect rather than captured at
 * construction, so a caller passing an inline lambda does not rebuild the tracker
 * every render — which would reset its dedupe memory and turn every frame into a
 * write, the exact opposite of what it is for.
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
        // Off the DOCUMENT and not off a prop: the overlays register on the registry
        // their own element's document holds, so a pane layout handed one by a caller
        // would be tracking an airspace nothing claims.
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
