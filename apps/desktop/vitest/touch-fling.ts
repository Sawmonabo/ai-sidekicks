// The hand of a touch fling, for the browser tier: played from the test server, outside the tested
// page, so a page busy with its own work does not hold the hand back.

import type { BrowserCommand } from "vitest/node";

import { playTouchFling, type TouchFlingGesture } from "#test/helpers/touch-fling.ts";

/**
 * Plays `gesture` on the tested page and resolves once the hand has let go; the momentum after it
 * is the page's to wait for.
 */
export const touchFling: BrowserCommand<[gesture: TouchFlingGesture]> = async (
  context,
  gesture,
) => {
  // The tested page is a frame in Vitest's own page; touches land in the outer page's pixels.
  const frameBox = await context.iframe.owner().boundingBox();
  if (frameBox === null) {
    throw new Error("the tested page's frame has no box to touch");
  }
  const cdpSession = await context.context.newCDPSession(context.page);
  try {
    await playTouchFling(cdpSession, {
      ...gesture,
      x: frameBox.x + gesture.x,
      y: frameBox.y + gesture.y,
    });
  } finally {
    await cdpSession.detach();
  }
};
