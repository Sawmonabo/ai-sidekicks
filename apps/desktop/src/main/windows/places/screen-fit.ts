// A kept rectangle brought wholly onto one display's work area. A display can be detached or
// rearranged between runs, so a kept place may sit partly or wholly off every screen; it is
// shrunk to fit the work area and moved the least distance that puts it inside.

import type { Rectangle } from "electron";

/** `bounds` moved and, where it is larger, shrunk to lie inside `workArea`. */
export function fitOnScreen(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(value, lowest), highest);
}
