// A touch fling, as the platform plays one: the hand's travel, then the compositor's momentum,
// one offset a frame, for the browser tier. The hand is played from outside the page
// (`vitest/touch-fling.ts`), so a page busy with its own work does not hold it back.

import { getConfig } from "@testing-library/react";
import { commands } from "vitest/browser";

import { letFramesPassUntilStill } from "#test/helpers/animation-frame.js";
import type { TouchFlingGesture } from "#test/helpers/touch-fling.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    touchFling: (gesture: TouchFlingGesture) => Promise<void>;
  }
}

/** The fastest flick a hand makes, in pixels a second. */
export const FASTEST_FLICK_SPEED = 17000;
/** The frames the list holds still for once a fling's momentum has run out. */
const FLING_STILL_FRAME_COUNT = 10;

/**
 * A touch fling from the box's middle, toward the head for a positive `distancePx`, at `speed`
 * pixels a second, and the frames of its momentum until the list holds still.
 */
export async function touchFling(
  scroller: HTMLElement,
  distancePx: number,
  speed: number,
): Promise<void> {
  const box = scroller.getBoundingClientRect();
  await getConfig().asyncWrapper(async () => {
    await commands.touchFling({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      distancePx,
      speed,
    });
  });
  await letFramesPassUntilStill(scroller, FLING_STILL_FRAME_COUNT);
}
