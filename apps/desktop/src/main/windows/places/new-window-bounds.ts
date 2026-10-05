// Where a window with no kept place opens. The first one opens centered on the display at a share
// of its work area; every further one cascades off the window used before it, a step down and to
// the right, past any open window whose corner it would share, so a new window never lands exactly
// over another. The step and the shared-corner check follow the cascade VS Code applies to a new
// window (`windowsStateHandler.ts`).

import type { Rectangle } from "electron";

import { fitOnScreen } from "./screen-fit.js";

/** The share of the work area's width and height a window with no kept place opens at. */
export const DEFAULT_WINDOW_WORK_AREA_SHARE = 0.8;

/** How far, in pixels, each cascaded window sits down and to the right of the one before. */
export const WINDOW_CASCADE_STEP = 30;

/**
 * The bounds a window with no kept place opens at on `workArea`: centered when no window is open,
 * otherwise cascaded off `openBounds[0]`, the window used last, and kept wholly on `workArea`.
 */
export function newWindowBounds(workArea: Rectangle, openBounds: readonly Rectangle[]): Rectangle {
  const previous = openBounds[0];
  if (previous === undefined) {
    const width = Math.round(workArea.width * DEFAULT_WINDOW_WORK_AREA_SHARE);
    const height = Math.round(workArea.height * DEFAULT_WINDOW_WORK_AREA_SHARE);
    return {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    };
  }
  let { x, y } = previous;
  // Steps at least once, off `previous` itself; ends because x and y only grow, so each open
  // window can match at most twice.
  while (openBounds.some((bounds) => bounds.x === x || bounds.y === y)) {
    x += WINDOW_CASCADE_STEP;
    y += WINDOW_CASCADE_STEP;
  }
  return fitOnScreen({ x, y, width: previous.width, height: previous.height }, workArea);
}
