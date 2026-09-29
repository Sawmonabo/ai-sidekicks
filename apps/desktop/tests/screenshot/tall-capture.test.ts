// The tier photographs the WHOLE element, proved on pixels rather than on mechanism.
//
// WHAT WAS GREEN AND WRONG. A Playwright element screenshot is a clip in page
// coordinates, the tester iframe is a fixed-size box in that page, and nothing
// composites an iframe's overflow: an image of a surface 2 050 px tall carried real
// content to row 899 and pure white to row 2 049, in the dark scheme too. Nothing about
// that was red — while this tier still compared against committed images, every one
// of them was stable and self-consistent and blank below the window's edge.
//
// SO THIS PROBE READS THE IMAGE. It renders a surface far taller than the window, paints
// its last hundred rows a colour no console token carries, holds the window open through
// the same `CaptureWindow` every capture goes through, and then DECODES the capture and
// asserts what is in it. Against the unfixed window logic the band comes back `#ffffff` —
// the page's own background, which is the whole finding — and no assertion about the
// capture mechanism, the viewport, or the clip could have said that as directly.
//
// IT WRITES NOTHING. The read below is `save: false`, so the bytes come back to the page
// and no image is written under a name a person would later look at and mistake for a
// console surface. The window bookkeeping is the real class's, so what is proved here is
// the mechanism `settled-capture.ts` composes rather than a second copy of it.
//
// AND IT IS PINNED TO NO HOST. The colours are flat fills, so there is no glyph and no
// font in the claim — it holds on any machine that can run the tier.

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { CapturedPng } from "./png-reader.js";
import { CaptureWindow } from "./settled-capture.js";

/** Well past the 900 px window, so the band sits in territory no capture used to reach. */
const PROBE_HEIGHT_PX = 2400;

/** The band at the bottom, deep enough that a one-row rounding error cannot explain it. */
const PROBE_BAND_HEIGHT_PX = 100;

/**
 * Inset from the document's left edge and narrower than the window.
 *
 * The tier captures surfaces of both shapes — a repos section spans the full 1440 and an
 * approvals pane 1438 — and an element inset from the page is the one the clip arithmetic
 * can get wrong in a way a full-width element hides. So the probe is the inset shape.
 */
const PROBE_WIDTH_PX = 1200;

/** How far in from the document's left edge the surface starts. */
const PROBE_LEFT_PX = 24;

/** The field, in a colour `tokens/palette.ts` carries nowhere. */
const PROBE_FIELD_COLOUR = "#00ffff";

/** The band, in a second such colour, so neither can be mistaken for the other. */
const PROBE_BAND_COLOUR = "#ff00ff";

/** What an unpainted row comes back as, and what the defect produced below the window. */
const PAGE_BACKGROUND_COLOUR = "#ffffff";

/**
 * How far the window-derived surface below hangs past whatever window it is in.
 *
 * The console's two full-height destinations measure exactly this much past theirs —
 * `min-height: 100%` around 32px of their own padding — so the probe reproduces the
 * shape with the arithmetic written out rather than inherited from a layout.
 */
const PROBE_OVERHANG_PX = 64;

/** A surface taller than any window this tier opens, with its last rows in one colour. */
function mountTallProbeSurface(): HTMLElement {
  const surface = document.createElement("div");
  surface.style.position = "absolute";
  surface.style.top = "0";
  surface.style.left = `${String(PROBE_LEFT_PX)}px`;
  surface.style.width = `${String(PROBE_WIDTH_PX)}px`;
  surface.style.height = `${String(PROBE_HEIGHT_PX)}px`;
  surface.style.background = PROBE_FIELD_COLOUR;

  const band = document.createElement("div");
  band.style.position = "absolute";
  band.style.left = "0";
  band.style.right = "0";
  band.style.bottom = "0";
  band.style.height = `${String(PROBE_BAND_HEIGHT_PX)}px`;
  band.style.background = PROBE_BAND_COLOUR;
  surface.append(band);

  document.body.append(surface);
  return surface;
}

/**
 * A surface one window tall plus a constant, which is the shape no window holds.
 *
 * `calc(100vh + …)` states the dependence outright instead of building an ancestor
 * chain that happens to produce it: the claim under test is about a box that tracks
 * its window, and a probe whose tracking is three stylesheets deep would be a probe
 * of those stylesheets.
 */
function mountWindowDerivedProbeSurface(): HTMLElement {
  const surface = document.createElement("div");
  surface.style.position = "absolute";
  surface.style.top = "0";
  surface.style.left = `${String(PROBE_LEFT_PX)}px`;
  surface.style.width = `${String(PROBE_WIDTH_PX)}px`;
  surface.style.height = `calc(100vh + ${String(PROBE_OVERHANG_PX)}px)`;
  surface.style.background = PROBE_FIELD_COLOUR;
  document.body.append(surface);
  return surface;
}

/**
 * Hold the window the way a capture does, and hand back the pixels rather than a file.
 *
 * The window bookkeeping is the REAL class — the same one `captureSettled` composes —
 * so the sizing, the ceiling, the `grows-with-its-window` arm, and the restore are all
 * the shipped ones. Only the last step differs: a capture writes an image and this
 * takes the bytes, because a claim about what is in a picture has to read the picture.
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

  it("photographs every row of a surface taller than the window", async () => {
    const surface = mountTallProbeSurface();
    const windowHeightBefore = window.innerHeight;

    const image = await capturePixelsOf(surface, "tall-probe");

    // The dimensions first, so a capture that was clipped rather than blanked fails
    // here with the two numbers rather than in the band assertion with a colour.
    expect(image.width).toBe(PROBE_WIDTH_PX);
    expect(image.height).toBe(surface.scrollHeight);

    // The band, at both its edges. Before the fix these rows are `#ffffff` — the page
    // showing through where the iframe stopped painting.
    expect(image.rowColours(image.height - 1)).toStrictEqual([PROBE_BAND_COLOUR]);
    expect(image.rowColours(image.height - PROBE_BAND_HEIGHT_PX)).toStrictEqual([
      PROBE_BAND_COLOUR,
    ]);

    // The field immediately above it, so the band assertion is not satisfied by an
    // image that is magenta everywhere — and a row deep in the region the window never
    // used to reach, which is the row the defect turned white.
    expect(image.rowColours(image.height - PROBE_BAND_HEIGHT_PX - 1)).toStrictEqual([
      PROBE_FIELD_COLOUR,
    ]);
    expect(image.rowColours(windowHeightBefore * 2)).toStrictEqual([PROBE_FIELD_COLOUR]);

    // Nothing in the image is the page's own background, which is the whole finding
    // stated as the property that failed: every row of this capture was painted.
    expect(image.rowColours(0)).not.toContain(PAGE_BACKGROUND_COLOUR);
  });

  it("puts the window back after a capture that grew it", async () => {
    // The other half of the fix, and the half a pixel assertion cannot see: a capture
    // that opened the window and left it open hands the next spec a console laid out
    // at 2 400 px, and every image after it in the file is a different surface.
    const surface = mountTallProbeSurface();
    const windowBefore = { width: window.innerWidth, height: window.innerHeight };

    await capturePixelsOf(surface, "tall-probe-restores-the-window");

    expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual(windowBefore);
  });

  it("photographs a window-derived surface at the tier's own window", async () => {
    // The one shape growing cannot fix, and the reason the chokepoint stops instead
    // of chasing: this surface is one window tall plus 64px at EVERY window, so each
    // grow moves both numbers together. The claim is that the capture is taken at
    // the size the tier configures — not at whatever the loop climbed to — and that
    // the unpainted band is exactly the overhang and nothing more.
    const surface = mountWindowDerivedProbeSurface();
    const windowBefore = { width: window.innerWidth, height: window.innerHeight };

    const image = await capturePixelsOf(surface, "window-derived-probe");

    expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual(windowBefore);
    expect(image.height).toBe(windowBefore.height + PROBE_OVERHANG_PX);

    // Painted to the window's last row, and the page's background for the overhang
    // below it. Asserting the band rather than eliding it is the point: it is the
    // residual this arm accepts, it is bounded by the surface's own padding, and a
    // change in its size fails here rather than appearing at the bottom of an image
    // nobody scrolls to.
    expect(image.rowColours(windowBefore.height - 1)).toStrictEqual([PROBE_FIELD_COLOUR]);
    expect(image.rowColours(image.height - 1)).toStrictEqual([PAGE_BACKGROUND_COLOUR]);
  });
});
