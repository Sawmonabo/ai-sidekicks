// The heights the palette's windowed list is laid out against. happy-dom lays nothing out, and a
// scroller with no height correctly draws no rows, so a suite that reads a row states them. The
// install is a call, not a constant, because it pairs an install with its restore.

import { afterEach, beforeEach } from "vitest";

import { ElementHeightShim } from "@test/helpers/element/element-height-shim.js";

/** How tall the list's scroller is: ten command rows, so a long list overflows it. */
const PALETTE_FIXTURE_VIEWPORT_HEIGHT_PX = 320;

/** How tall one command row is. */
const PALETTE_FIXTURE_ROW_HEIGHT_PX = 32;

/** How tall one category heading is. */
const PALETTE_FIXTURE_LABEL_HEIGHT_PX = 24;

/** Give a suite the heights a browser would lay the palette's list out at. */
export function installPaletteLayout(): void {
  const shim = new ElementHeightShim();
  beforeEach(() => {
    shim.install(laidOutHeightPx);
  });
  afterEach(() => {
    shim.restore();
  });
}

/**
 * Give the list's scroller the scroll extent a browser would: the rows' total height inside a
 * viewport-tall box. The window clamps every scroll to that extent, which happy-dom reports as
 * zero. Set on the one element, so nothing outlives the render.
 */
export function layOutScrollExtent(scroller: HTMLElement): void {
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => PALETTE_FIXTURE_VIEWPORT_HEIGHT_PX },
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(
          scroller.querySelector<HTMLElement>(".command-palette__rows")?.style.blockSize ?? "0",
        ),
    },
  });
}

function laidOutHeightPx(element: HTMLElement): number {
  if (element.classList.contains("command-palette__list")) {
    return PALETTE_FIXTURE_VIEWPORT_HEIGHT_PX;
  }
  if (element.classList.contains("command-palette__item")) {
    return PALETTE_FIXTURE_ROW_HEIGHT_PX;
  }
  return element.classList.contains("command-palette__group-label")
    ? PALETTE_FIXTURE_LABEL_HEIGHT_PX
    : 0;
}
