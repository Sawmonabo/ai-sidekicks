// A touch fling, as the platform plays one: the hand's travel, then the compositor's momentum,
// one offset a frame, for the browser tier.

import { getConfig } from "@testing-library/react";
import { cdp } from "vitest/browser";

import { letFramesPass } from "#test/helpers/animation-frame.js";

/** The fastest flick a hand makes, in pixels a second. */
export const FASTEST_FLICK_SPEED = 17000;
/** The frames the offset holds still for once a fling's momentum has run out. */
const FLING_STILL_FRAME_COUNT = 10;
/** How far the offset may move in a frame and still be holding still: a device pixel. */
const STILL_GRAIN_PX = 1;

/**
 * A touch fling from the box's middle, toward the head for a positive `distancePx`, at `speed`
 * pixels a second, and the frames of its momentum until the offset holds still.
 */
export async function touchFling(
  scroller: HTMLElement,
  distancePx: number,
  speed: number,
): Promise<void> {
  const box = scroller.getBoundingClientRect();
  await getConfig().asyncWrapper(async () => {
    await cdp().send("Input.synthesizeScrollGesture", {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      yDistance: distancePx,
      speed,
      gestureSourceType: "touch",
      preventFling: false,
    });
  });
  for (let stillFrames = 0, lastScrollTopPx = -1; stillFrames < FLING_STILL_FRAME_COUNT; ) {
    await letFramesPass(1);
    stillFrames =
      Math.abs(scroller.scrollTop - lastScrollTopPx) < STILL_GRAIN_PX ? stillFrames + 1 : 0;
    lastScrollTopPx = scroller.scrollTop;
  }
}
