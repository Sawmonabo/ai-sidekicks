// Moves the sessions track open and shut. The frame's grid animates its columns only while the
// track opens or closes, so a text-size or full-screen change resizes them at once. A closing
// track keeps its last content until the grid has finished moving, so nothing vanishes before the
// column slides over it. Under reduced motion nothing moves and the track settles at once.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "#renderer/lib/reduced-motion.js";

/** Where the sessions track is: at rest open or closed, or moving between the two. */
export type SessionsTrackState = "open" | "opening" | "closing" | "closed";

/** What the frame draws for its sessions track, and what it hands the grid that moves it. */
export interface SessionsTrackMotion {
  /** What the track holds: the caller's content, or its last content while the track closes. */
  readonly content: React.ReactNode;
  readonly state: SessionsTrackState;
  /** The frame, whose grid moves. */
  readonly frameRef: React.RefObject<HTMLDivElement | null>;
  /** The frame's `transitionend` listener, which settles the track when its grid stops moving. */
  readonly onTransitionEnd: (event: React.TransitionEvent<HTMLDivElement>) => void;
}

/**
 * The sessions track's content and state for `sessionsTrack`, which is `undefined` while the
 * track is closed. A track open on first render starts at rest, with nothing moving.
 */
export function useAnimateSessionsTrack(
  sessionsTrack: React.ReactNode | undefined,
): SessionsTrackMotion {
  const frameRef = useRef<HTMLDivElement | null>(null);
  // The content the track last drew, which a close keeps on screen while the grid moves.
  const drawnContentRef = useRef<React.ReactNode>(sessionsTrack);
  const [heldTrack, setHeldTrack] = useState<HeldTrack>(() => ({
    state: sessionsTrack === undefined ? "closed" : "open",
    closingContent: undefined,
  }));
  // Followed during render, so the frame never draws one commit behind its caller. It changes
  // only when the track opens or closes, not on every new content the caller hands it.
  const followed = followCaller(heldTrack, sessionsTrack, drawnContentRef.current);
  if (followed !== heldTrack) {
    setHeldTrack(followed);
  }

  const settle = useCallback(() => {
    setHeldTrack(settleTrack);
  }, []);

  const { state } = followed;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const ownerWindow = frame?.ownerDocument.defaultView;
    if ((state !== "opening" && state !== "closing") || frame == null || ownerWindow == null) {
      return;
    }
    // With no motion wanted, or a grid already where it is going (a track reopened before its
    // close had begun), no transition ends to settle the track, so it settles now.
    if (prefersReducedMotion(ownerWindow) || !isGridMoving(frame)) {
      settle();
    }
  }, [state, settle]);

  const onTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      // Transitions inside the frame bubble here; only the grid's own columns settle the track.
      if (event.target === event.currentTarget && event.propertyName === "grid-template-columns") {
        settle();
      }
    },
    [settle],
  );

  const content = sessionsTrack ?? (state === "closing" ? followed.closingContent : undefined);
  useLayoutEffect(() => {
    drawnContentRef.current = content;
  });
  return { content, state, frameRef, onTransitionEnd };
}

/** The track's state, and while it closes the content it last held. */
interface HeldTrack {
  readonly state: SessionsTrackState;
  readonly closingContent: React.ReactNode;
}

const CLOSED_TRACK: HeldTrack = { state: "closed", closingContent: undefined };

/**
 * The track after the caller handed it `sessionsTrack`, `held` itself when it neither opened nor
 * closed. A close keeps `drawnContent`, what the track drew last.
 */
function followCaller(
  held: HeldTrack,
  sessionsTrack: React.ReactNode | undefined,
  drawnContent: React.ReactNode,
): HeldTrack {
  const isOpenOrOpening = held.state === "open" || held.state === "opening";
  if (sessionsTrack === undefined) {
    return isOpenOrOpening ? { state: "closing", closingContent: drawnContent } : held;
  }
  return isOpenOrOpening ? held : { state: "opening", closingContent: undefined };
}

/** Whether the frame's grid is running a transition of its columns. Reading it starts one due. */
function isGridMoving(frame: HTMLElement): boolean {
  return frame
    .getAnimations()
    .some(
      (animation) =>
        animation instanceof CSSTransition &&
        animation.transitionProperty === "grid-template-columns",
    );
}

/** The track once its grid has stopped moving. */
function settleTrack(held: HeldTrack): HeldTrack {
  switch (held.state) {
    case "opening":
      return { state: "open", closingContent: undefined };
    case "closing":
      return CLOSED_TRACK;
    case "open":
    case "closed":
      return held;
  }
}
