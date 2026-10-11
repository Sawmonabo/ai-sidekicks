// How much of the transcript's box no drawn row covers, read from the rows' laid-out boxes.

import { ROW_SELECTOR } from "./long-tool-feed.js";

/** How far a row may stand past the box's edge and still be drawn for it: a device pixel. */
export const GRAIN_PX = 1;

/** How much of `scroller`'s height no drawn row covers, in pixels. */
export function unfilledHeightPx(scroller: HTMLElement): number {
  const box = scroller.getBoundingClientRect();
  const rects = [...scroller.querySelectorAll(ROW_SELECTOR)]
    .map((row) => row.getBoundingClientRect())
    .sort((first, second) => first.top - second.top);
  let coveredToPx = box.top;
  let unfilledPx = 0;
  for (const rect of rects) {
    if (rect.top > coveredToPx + GRAIN_PX) {
      unfilledPx += Math.min(rect.top, box.bottom) - coveredToPx;
    }
    coveredToPx = Math.max(coveredToPx, Math.min(rect.bottom, box.bottom));
  }
  return unfilledPx + Math.max(0, box.bottom - coveredToPx - GRAIN_PX);
}
