// Proves the tier photographs the whole element, on pixels rather than mechanism. A Playwright
// element screenshot is a clip in page coordinates and nothing composites an iframe's overflow,
// so an image of a 2 050 px element carried content to row 899 and white to row 2 049, in both
// schemes; every such image is stable, self-consistent and blank below the window's edge. This
// probe renders an element far taller than the window, paints its last hundred rows a color no
// console token carries, holds the window through the real `CaptureWindow`, then decodes the
// capture and asserts what is in it. Without the window logic the band comes back `#ffffff`, the
// page background.
//
// It writes nothing: the read is `save: false`, so no image lands under a name a person would
// mistake for a capture of the console. The colors are flat fills, so no glyph or font is in the
// claim and it holds on any host that can run the tier.

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { CapturedPng } from "./png-reader.js";
import { CaptureWindow } from "./settled-capture.js";

/** Well past the 900 px window, so the band sits below the original window's edge. */
const PROBE_HEIGHT_PX = 2400;

/** The band at the bottom, deep enough that a one-row rounding error cannot explain it. */
const PROBE_BAND_HEIGHT_PX = 100;

/**
 * Inset from the document's left edge and narrower than the window: the tier captures full-width
 * elements, and an inset element is the one the clip arithmetic can get wrong in a way a
 * full-width one hides.
 */
const PROBE_WIDTH_PX = 1200;

/** How far in from the document's left edge the probe starts. */
const PROBE_LEFT_PX = 24;

/** The field, in a color `styles/palette.ts` carries nowhere. */
const PROBE_FIELD_COLOR = "#00ffff";

/** The band, in a second such color, so neither can be mistaken for the other. */
const PROBE_BAND_COLOR = "#ff00ff";

/** What an unpainted row comes back as, and what the defect produced below the window. */
const PAGE_BACKGROUND_COLOR = "#ffffff";

/**
 * How far the window-derived probe hangs past whatever window it is in. The console's two
 * full-height destinations measure this much past theirs (`min-height: 100%` around 32px of
 * padding), so the probe writes the arithmetic out instead of inheriting a layout.
 */
const PROBE_OVERHANG_PX = 64;

/** A probe taller than any window this tier opens, with its last rows in one color. */
function mountTallProbe(): HTMLElement {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.top = "0";
  probe.style.left = `${String(PROBE_LEFT_PX)}px`;
  probe.style.width = `${String(PROBE_WIDTH_PX)}px`;
  probe.style.height = `${String(PROBE_HEIGHT_PX)}px`;
  probe.style.background = PROBE_FIELD_COLOR;

  const band = document.createElement("div");
  band.style.position = "absolute";
  band.style.left = "0";
  band.style.right = "0";
  band.style.bottom = "0";
  band.style.height = `${String(PROBE_BAND_HEIGHT_PX)}px`;
  band.style.background = PROBE_BAND_COLOR;
  probe.append(band);

  document.body.append(probe);
  return probe;
}

/**
 * A probe one window tall plus a constant, the shape no window holds. `calc(100vh + …)` states
 * the dependence outright; a box whose tracking is three stylesheets deep would be a probe of
 * those stylesheets.
 */
function mountWindowDerivedProbe(): HTMLElement {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.top = "0";
  probe.style.left = `${String(PROBE_LEFT_PX)}px`;
  probe.style.width = `${String(PROBE_WIDTH_PX)}px`;
  probe.style.height = `calc(100vh + ${String(PROBE_OVERHANG_PX)}px)`;
  probe.style.background = PROBE_FIELD_COLOR;
  document.body.append(probe);
  return probe;
}

/**
 * Holds the window the way a capture does and returns the pixels, not a file. The window
 * bookkeeping is the real class `captureSettled` composes; only the last step differs, since a
 * claim about what is in a picture has to read the picture.
 */
async function capturePixelsOf(element: Element, probeName: string): Promise<CapturedPng> {
  const captureWindow = new CaptureWindow({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  try {
    await captureWindow.holdWhole(element, probeName);
    return await CapturedPng.decode(await page.screenshot({ element, save: false }));
  } finally {
    await captureWindow.restore();
  }
}

describe("the screenshot tier's capture reaches the whole element", () => {
  afterEach(() => {
    for (const leftOver of document.body.querySelectorAll("div")) {
      leftOver.remove();
    }
  });

  it("photographs every row of an element taller than the window", async () => {
    const probe = mountTallProbe();
    const windowHeightBefore = window.innerHeight;

    const image = await capturePixelsOf(probe, "tall-probe");

    // Dimensions first, so a clipped capture fails here with the two numbers, not in the band
    // assertion with a color.
    expect(image.width).toBe(PROBE_WIDTH_PX);
    expect(image.height).toBe(probe.scrollHeight);

    // The band at both its edges; unpainted rows would read `#ffffff`, the page showing through
    // where the iframe stopped painting.
    expect(image.rowColors(image.height - 1)).toStrictEqual([PROBE_BAND_COLOR]);
    expect(image.rowColors(image.height - PROBE_BAND_HEIGHT_PX)).toStrictEqual([PROBE_BAND_COLOR]);

    // The field just above the band, so an all-magenta image cannot pass, and a row past the
    // original window, which is the row an unpainted capture turns white.
    expect(image.rowColors(image.height - PROBE_BAND_HEIGHT_PX - 1)).toStrictEqual([
      PROBE_FIELD_COLOR,
    ]);
    expect(image.rowColors(windowHeightBefore * 2)).toStrictEqual([PROBE_FIELD_COLOR]);

    // Nothing is the page's own background: every row of this capture was painted.
    expect(image.rowColors(0)).not.toContain(PAGE_BACKGROUND_COLOR);
  });

  it("puts the window back after a capture that grew it", async () => {
    // The half a pixel assertion cannot see: a capture that leaves the window open hands the next
    // spec a console laid out at 2 400 px.
    const probe = mountTallProbe();
    const windowBefore = { width: window.innerWidth, height: window.innerHeight };

    await capturePixelsOf(probe, "tall-probe-restores-the-window");

    expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual(windowBefore);
  });

  it("photographs a window-derived element at the tier's own window", async () => {
    // The one shape growing cannot fix, so the chokepoint stops instead of chasing: this probe is
    // one window tall plus 64px at every window. The capture is taken at the size the tier
    // configures, not where the loop climbed to, and the unpainted band is exactly the overhang.
    const probe = mountWindowDerivedProbe();
    const windowBefore = { width: window.innerWidth, height: window.innerHeight };

    const image = await capturePixelsOf(probe, "window-derived-probe");

    expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual(windowBefore);
    expect(image.height).toBe(windowBefore.height + PROBE_OVERHANG_PX);

    // Painted to the window's last row, and the page background for the overhang. Asserting the
    // band is the point: it is the residual this arm accepts, bounded by a full-height screen's
    // own padding, and a change in its size fails here.
    expect(image.rowColors(windowBefore.height - 1)).toStrictEqual([PROBE_FIELD_COLOR]);
    expect(image.rowColors(image.height - 1)).toStrictEqual([PAGE_BACKGROUND_COLOR]);
  });
});
