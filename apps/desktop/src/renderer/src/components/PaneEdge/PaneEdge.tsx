// A pane's drag edge: a focusable separator that sets one size, a pane's width or the stacked
// terminal's height. Dragged with the pointer it draws the size live and keeps it on release;
// the edge moves the way an arrow points, so the arrow pointing out of the pane grows it by one
// nudge of the text size, five with Shift, and `Home` or a double-click returns it to its default.
// It reports the size it draws and its two limits on every set.
//
// A drag ends however its capture is lost: the loss is heard on the edge's own document, where
// the edge's own loss bubbles and where the loss of an edge taken out of its document is fired,
// and an edge unmounted mid-drag ends its drag as it goes, keeping nothing.

import "./PaneEdge.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { rootFontSizePx } from "#renderer/lib/root-font-size.js";
import { PANE_EDGE_LARGE_STEP_REM, PANE_EDGE_STEP_REM } from "#renderer/styles/palette.js";

/** A size an edge sets and its two limits, in CSS px. */
export interface PaneEdgeReading {
  readonly sizePx: number;
  readonly minimumPx: number;
  readonly maximumPx: number;
}

/** The arrow key that grows the size an edge sets; the opposite arrow shrinks it. */
export type PaneEdgeGrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/** What a pane edge sets and how. */
export interface PaneEdgeProps {
  /** The id of the pane's own name, which names the separator, as a window splitter is named. */
  readonly labelledBy: string;
  /** The id of the pane the separator sizes. */
  readonly controls: string;
  readonly growKey: PaneEdgeGrowKey;
  /**
   * The size kept now and its limits, measured at the moment of asking. A new function whenever
   * what it measures changed, the text size included, so the edge reads it again.
   */
  readonly measure: () => PaneEdgeReading;
  /** Draws a size while the edge is dragged, or clears that drawing with `undefined`. */
  readonly onPreview: (sizePx: number | undefined) => void;
  /** Keeps a size, or returns it to its default with `undefined`. */
  readonly onSet: (sizePx: number | undefined) => void;
  /** Called as a drag begins and ends, so the layout holds its transitions while it runs. */
  readonly onResizingChange: (isResizing: boolean) => void;
}

/** One drag edge. Its orientation follows its grow key: a width edge stands, a height edge lies. */
export function PaneEdge(props: PaneEdgeProps): React.JSX.Element {
  const { measure, onPreview, onSet, onResizingChange, growKey } = props;
  const isWidth = growKey === "ArrowLeft" || growKey === "ArrowRight";
  const [reading, setReading] = useState<PaneEdgeReading | undefined>(undefined);
  const [isHeld, setIsHeld] = useState(false);
  const dragRef = useRef<EdgeDrag | undefined>(undefined);

  // Read after every render that changes what is measured, once every element it reads is
  // drawn, so a set is reported as drawn, held by the floor or the ceiling included.
  useEffect(() => {
    setReading(drawnReading(measure()));
  }, [measure]);

  const endDrag = useCallback(
    (isKept: boolean) => {
      const drag = dragRef.current;
      if (drag === undefined) {
        return;
      }
      dragRef.current = undefined;
      drag.listeners.abort();
      setIsHeld(false);
      onPreview(undefined);
      onResizingChange(false);
      if (isKept && drag.sizePx !== drag.start.sizePx) {
        onSet(drag.sizePx);
      }
    },
    [onPreview, onResizingChange, onSet],
  );
  const endDragRef = useLatestRef(endDrag);
  const unmountedHandlersRef = useLatestRef({ onPreview, onResizingChange });

  // An edge taken away mid-drag, its pane closed under the hand, keeps nothing and leaves the
  // layout resizing nothing.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag === undefined) {
        return;
      }
      dragRef.current = undefined;
      drag.listeners.abort();
      unmountedHandlersRef.current.onPreview(undefined);
      unmountedHandlersRef.current.onResizingChange(false);
    },
    [unmountedHandlersRef],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Home") {
        event.preventDefault();
        onSet(undefined);
        return;
      }
      const direction = growDirection(growKey, event.key);
      if (direction === 0 || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      event.preventDefault();
      const stepRem = event.shiftKey ? PANE_EDGE_LARGE_STEP_REM : PANE_EDGE_STEP_REM;
      const now = drawnReading(measure());
      const stepPx = stepRem * rootFontSizePx(event.currentTarget.ownerDocument);
      onSet(clamp(now.sizePx + direction * stepPx, now));
    },
    [growKey, measure, onSet],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const edge = event.currentTarget;
      const ownerWindow = edge.ownerDocument.defaultView;
      if (ownerWindow === null) {
        throw new Error("A pane edge was pressed in a document with no window.");
      }
      edge.setPointerCapture(event.pointerId);
      const pointerId = event.pointerId;
      const listeners = new ownerWindow.AbortController();
      edge.ownerDocument.addEventListener(
        "lostpointercapture",
        (lost) => {
          if (lost.pointerId === pointerId && (lost.target === edge || !edge.isConnected)) {
            endDragRef.current(false);
          }
        },
        { signal: listeners.signal },
      );
      const start = drawnReading(measure());
      setReading(start);
      dragRef.current = {
        pointerId,
        startPointer: isWidth ? event.clientX : event.clientY,
        start,
        sizePx: start.sizePx,
        listeners,
      };
      setIsHeld(true);
      onResizingChange(true);
    },
    [endDragRef, isWidth, measure, onResizingChange],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) {
        return;
      }
      const travel = (isWidth ? event.clientX : event.clientY) - drag.startPointer;
      // The pointer moving the way the grow key points grows the size.
      const grows = growKey === "ArrowLeft" || growKey === "ArrowUp" ? -travel : travel;
      drag.sizePx = clamp(drag.start.sizePx + grows, drag.start);
      onPreview(drag.sizePx);
    },
    [growKey, isWidth, onPreview],
  );

  return (
    <div
      className="meridian-pane-edge"
      data-orientation={isWidth ? "vertical" : "horizontal"}
      // The edge lies on the side of its pane its grow key points to.
      data-place={growKey === "ArrowLeft" || growKey === "ArrowUp" ? "start" : "end"}
      data-held={isHeld ? "" : undefined}
      role="separator"
      tabIndex={0}
      aria-labelledby={props.labelledBy}
      aria-controls={props.controls}
      aria-orientation={isWidth ? "vertical" : "horizontal"}
      aria-valuenow={reading === undefined ? undefined : Math.round(reading.sizePx)}
      aria-valuemin={reading === undefined ? undefined : Math.round(reading.minimumPx)}
      aria-valuemax={reading === undefined ? undefined : Math.round(reading.maximumPx)}
      onKeyDown={onKeyDown}
      // The ceiling moves with the window, so a person arriving reads the limits as they are now.
      onFocus={() => {
        setReading(drawnReading(measure()));
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          endDrag(true);
        }
      }}
      onDoubleClick={() => {
        onSet(undefined);
      }}
    />
  );
}

/** One pointer drag of an edge, from its press. */
interface EdgeDrag {
  readonly pointerId: number;
  readonly startPointer: number;
  readonly start: PaneEdgeReading;
  sizePx: number;
  /** Aborts the listeners the press bound on the edge's document. */
  readonly listeners: AbortController;
}

/** `1` for the grow key, `-1` for its opposite, `0` for any other key. */
function growDirection(growKey: PaneEdgeGrowKey, key: string): -1 | 0 | 1 {
  if (key === growKey) {
    return 1;
  }
  return key === OPPOSITE_KEY[growKey] ? -1 : 0;
}

const OPPOSITE_KEY: Readonly<Record<PaneEdgeGrowKey, PaneEdgeGrowKey>> = {
  ArrowLeft: "ArrowRight",
  ArrowRight: "ArrowLeft",
  ArrowUp: "ArrowDown",
  ArrowDown: "ArrowUp",
};

/**
 * A reading as the layout draws it: a ceiling under the floor gives way to the floor, and a kept
 * size past either limit is drawn at that limit, so the value reported never leaves its range and
 * a press moves from what is on screen.
 */
function drawnReading(reading: PaneEdgeReading): PaneEdgeReading {
  const limits = {
    minimumPx: reading.minimumPx,
    maximumPx: Math.max(reading.minimumPx, reading.maximumPx),
  };
  return { ...limits, sizePx: clamp(reading.sizePx, limits) };
}

function clamp(sizePx: number, limits: Omit<PaneEdgeReading, "sizePx">): number {
  return Math.min(Math.max(sizePx, limits.minimumPx), limits.maximumPx);
}
