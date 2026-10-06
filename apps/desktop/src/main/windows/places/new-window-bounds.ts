// Where a window with no kept place opens. Its size is taken from the display's own work area: a
// window of session views fills it but for one cascade step on every side, and a pane's own window
// is as wide as the renderer says that pane opens and as tall as the work area. The first one
// opens centered on the display; every further one cascades off the window used before it, a step
// down and to the right, past any open window whose corner it would share, so a new window never
// lands exactly over another: it gives up what would pass the work area's far edges, and only when
// no room is left is it moved back onto the work area. The step and the shared-corner check follow
// the cascade VS Code applies to a new window (`windowsStateHandler.ts`).

import type { Rectangle } from "electron";

import { fitOnScreen } from "./screen-fit.js";

/** How far, in pixels, each cascaded window sits down and to the right of the one before. */
const WINDOW_CASCADE_STEP = 30;

/**
 * What a window with no kept place holds: session views, or one pane, `width` being the width the
 * renderer handed for that pane's kind, `undefined` before it handed one.
 */
export type NewWindowContent =
  | { readonly kind: "session-views" }
  | { readonly kind: "pane"; readonly width: number | undefined };

/**
 * The bounds a window holding `content` opens at on `workArea` when it has no kept place:
 * centered when no window is open, otherwise cascaded off `openBounds[0]`, the window used last.
 */
export function newWindowBounds(
  workArea: Rectangle,
  content: NewWindowContent,
  openBounds: readonly Rectangle[],
): Rectangle {
  const { width, height } = newWindowSize(workArea, content);
  const previous = openBounds[0];
  if (previous === undefined) {
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
  const roomAcross = workArea.x + workArea.width - x;
  const roomDown = workArea.y + workArea.height - y;
  return fitOnScreen(
    {
      x,
      y,
      width: roomAcross > 0 ? Math.min(width, roomAcross) : width,
      height: roomDown > 0 ? Math.min(height, roomDown) : height,
    },
    workArea,
  );
}

function newWindowSize(
  workArea: Rectangle,
  content: NewWindowContent,
): Pick<Rectangle, "width" | "height"> {
  if (content.kind === "session-views") {
    return {
      width: Math.max(workArea.width - 2 * WINDOW_CASCADE_STEP, 0),
      height: Math.max(workArea.height - 2 * WINDOW_CASCADE_STEP, 0),
    };
  }
  return {
    width: Math.min(Math.ceil(content.width ?? workArea.width), workArea.width),
    height: workArea.height,
  };
}
