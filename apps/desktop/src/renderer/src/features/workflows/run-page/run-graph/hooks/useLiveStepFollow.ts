import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, useStore, type OnMoveStart } from "@xyflow/react";

import { useOwnerWindow } from "@renderer/hooks/owner-window/useOwnerWindow.js";
import { prefersReducedMotion } from "@renderer/lib/reduced-motion.js";
import { MOTION_DURATIONS_MS } from "@renderer/styles/motion.js";
import type { CanvasPoint } from "../run-graph-layout.js";
import { useInViewRef } from "./useInViewRef.js";

/** Whether the view follows the live step, and the ways a person stops and restarts it. */
export interface LiveStepFollow {
  readonly isFollowing: boolean;
  /**
   * True while the follow is off and the view has drifted off the live step: pressing the `now`
   * chip would move the view, so the chip is drawn.
   */
  readonly canReturnToLiveStep: boolean;
  /** Stops the follow; nothing starts it again except `resumeFollowing`. */
  readonly stopFollowing: () => void;
  /** Slides the view back to the live step and follows it again. */
  readonly resumeFollowing: () => void;
  /** Stops the follow on a pan or zoom a person started; the library's own moves pass no event. */
  readonly stopOnPersonMove: OnMoveStart;
  /** Brings a point into view at the current zoom when it stands outside the canvas. */
  readonly revealPoint: (point: CanvasPoint) => void;
}

/**
 * How much of the canvas is left empty around the whole graph when it is fitted, as a fraction:
 * keeps the first and last node clear of the canvas's edge.
 */
const RUN_GRAPH_FIT_PADDING = 0.12;

/** The zoom the graph opens at when it opens placed on the live step: the nodes at their size. */
const OPEN_ON_LIVE_STEP_ZOOM = 1;

/**
 * How far the live step's center may stand from the canvas's center, in screen pixels, and still
 * count as on it: under a pixel is no move a person could see.
 */
const ON_LIVE_STEP_TOLERANCE_PX = 1;

/** How long the view takes to slide to the live step, in milliseconds. */
const FOLLOW_SLIDE_MS = MOTION_DURATIONS_MS["motion-thread"] ?? 0;

/**
 * Keeps the view on the live step: placed on it when the graph opens, sliding after it as the
 * run moves, and fitting the whole graph while nothing is live. A pan, a zoom or a key a person
 * makes stops it, and only `resumeFollowing` starts it again. The slide runs only while the
 * canvas is on screen and never under reduced motion; otherwise the view jumps.
 */
export function useLiveStepFollow(
  liveCenter: CanvasPoint | undefined,
  canvasRef: React.RefObject<HTMLElement | null>,
): LiveStepFollow {
  const { fitView, getZoom, getViewport, setCenter } = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const [isFollowing, setIsFollowing] = useState(true);
  const hasPlacedRef = useRef(false);
  const isInViewRef = useInViewRef(canvasRef);
  const ownerWindow = useOwnerWindow();
  const liveX = liveCenter?.x;
  const liveY = liveCenter?.y;
  // A boolean, so a pan re-renders the canvas only when the answer flips.
  const isViewOnLiveStep = useStore((state) => {
    if (liveX === undefined || liveY === undefined) {
      return true;
    }
    const [translateX, translateY, zoom] = state.transform;
    return (
      Math.abs(liveX * zoom + translateX - state.width / 2) < ON_LIVE_STEP_TOLERANCE_PX &&
      Math.abs(liveY * zoom + translateY - state.height / 2) < ON_LIVE_STEP_TOLERANCE_PX
    );
  });

  const slideMs = useCallback(
    () => (isInViewRef.current && !prefersReducedMotion(ownerWindow) ? FOLLOW_SLIDE_MS : 0),
    [isInViewRef, ownerWindow],
  );

  useEffect(() => {
    if (!isFollowing || canvasWidth === 0 || canvasHeight === 0) {
      return;
    }
    // The first placement is where the graph opens, so it never slides in from elsewhere.
    const duration = hasPlacedRef.current ? slideMs() : 0;
    const placement =
      liveX === undefined || liveY === undefined
        ? fitView({ padding: RUN_GRAPH_FIT_PADDING, duration })
        : setCenter(liveX, liveY, {
            zoom: hasPlacedRef.current ? getZoom() : OPEN_ON_LIVE_STEP_ZOOM,
            duration,
          });
    // The library answers false while its pan and zoom are not mounted yet, and nothing moved.
    void placement.then((isPlaced) => {
      if (isPlaced) {
        hasPlacedRef.current = true;
      }
    });
  }, [isFollowing, liveX, liveY, canvasWidth, canvasHeight, fitView, getZoom, setCenter, slideMs]);

  const stopFollowing = useCallback(() => setIsFollowing(false), []);
  const resumeFollowing = useCallback(() => setIsFollowing(true), []);
  const stopOnPersonMove = useCallback<OnMoveStart>((event) => {
    if (event !== null) {
      setIsFollowing(false);
    }
  }, []);
  const revealPoint = useCallback(
    (point: CanvasPoint) => {
      const { x, y, zoom } = getViewport();
      const screenX = point.x * zoom + x;
      const screenY = point.y * zoom + y;
      if (screenX < 0 || screenY < 0 || screenX > canvasWidth || screenY > canvasHeight) {
        void setCenter(point.x, point.y, { zoom, duration: slideMs() });
      }
    },
    [canvasWidth, canvasHeight, getViewport, setCenter, slideMs],
  );

  return {
    isFollowing,
    canReturnToLiveStep: !isFollowing && !isViewOnLiveStep,
    stopFollowing,
    resumeFollowing,
    stopOnPersonMove,
    revealPoint,
  };
}
