// Where a window with no kept place opens. It is as wide as the renderer says its content needs
// and as tall as the work area less one cascade step above and below, never past the work area. The first one opens
// centered on the display; every further one cascades off the window used before it, a step down
// and to the right, past any open window whose corner it would share, so a new window never lands
// exactly over another. The step and the shared-corner check follow the cascade VS Code applies to
// a new window (`windowsStateHandler.ts`).

import type { Rectangle } from "electron";

import { fitOnScreen } from "./screen-fit.js";

/** How far, in pixels, each cascaded window sits down and to the right of the one before. */
const WINDOW_CASCADE_STEP = 30;

/**
 * The bounds a window with no kept place opens at on `workArea`, `width` wide (held to the work
 * area) and the work area's height less a cascade step above and below: centered when no window
 * is open, otherwise cascaded off `openBounds[0]`, the window used last, and kept wholly on
 * `workArea`.
 */
export function newWindowBounds(
  workArea: Rectangle,
  width: number,
  openBounds: readonly Rectangle[],
): Rectangle {
  const fittedWidth = Math.min(Math.ceil(width), workArea.width);
  const height = Math.max(workArea.height - 2 * WINDOW_CASCADE_STEP, 0);
  const previous = openBounds[0];
  if (previous === undefined) {
    return {
      x: workArea.x + Math.round((workArea.width - fittedWidth) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width: fittedWidth,
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
  return fitOnScreen({ x, y, width: fittedWidth, height }, workArea);
}
