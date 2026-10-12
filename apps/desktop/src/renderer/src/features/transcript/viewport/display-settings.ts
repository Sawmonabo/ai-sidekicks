// The display a transcript's row heights are measured on, read off the window that draws it: the
// screen's pixel ratio and the root font size.

import type { ViewportController } from "./controller.js";

/**
 * Tells `controller` the display `ownerWindow` draws on now: a new controller before its first
 * pass lays out any row, and again each time the display changes.
 */
export function declareDisplaySettings(controller: ViewportController, ownerWindow: Window): void {
  controller.observeDisplaySettings(
    ownerWindow.devicePixelRatio,
    Number.parseFloat(ownerWindow.getComputedStyle(ownerWindow.document.documentElement).fontSize),
  );
}
