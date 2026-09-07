// The tier photographs the WHOLE element, proved on pixels rather than on mechanism.
//
// WHAT WAS GREEN AND WRONG. `toMatchScreenshot` answers one question — does this capture
// equal the committed reference — so every reference this tier held was self-consistent
// while five of them were blank below row 899. A Playwright element screenshot is a clip
// in page coordinates, the tester iframe is a fixed-size box in that page, and nothing
// composites an iframe's overflow: `repos-section-mounted-gate-light` is 1440×2050 and
// carried real content to row 899 and pure white to row 2049, in the dark scheme too. A
// regression anywhere below the first window was green, and a dimension change was the
// only thing the tier could see there.
//
// SO THIS PROBE READS THE IMAGE. It renders a surface far taller than the window, paints
// its last hundred rows a colour no console token carries, captures it through the one
// chokepoint every spec uses, and then DECODES the file that capture wrote and asserts
// what is in it. Against the unfixed chokepoint the band comes back `#ffffff` — the
// page's own background, which is the whole finding — and no assertion about the capture
// mechanism, the viewport, or the clip could have said that as directly.
//
// IT MINTS NO REFERENCE. The name is the one `baseline-host.ts` reserves for exactly
// this, and the probe runs only while the run refuses to write references, which is the
// same guard `frame.test.tsx`'s fail-closed probe takes and for the same reason: under
// `-u` the matcher is SUPPOSED to write and pass, and a probe that ran there would commit
// a magenta rectangle to `__screenshots__`. Under `none` the matcher writes its candidate
// into the gitignored attachments directory and names the path in its failure, which is
// the file read below.
//
// AND IT IS PINNED TO NO HOST. The colours are flat fills, so there is no glyph and no
// font in the claim — it holds on any machine that can run the tier, exactly like the
// fail-closed guard beside it.

import { afterEach, describe, expect, it } from "vitest";

import { screenshotUpdateMode, UNCOMMITTED_REFERENCE_NAME } from "./baseline-host.js";
import { CapturedPng } from "./png-reader.js";
import { captureSettled } from "./settled-capture.js";

/** Well past the 900 px window, so the band sits in territory no capture used to reach. */
const PROBE_HEIGHT_PX = 2400;

/** The band at the bottom, deep enough that a one-row rounding error cannot explain it. */
const PROBE_BAND_HEIGHT_PX = 100;

/**
 * Inset from the document's left edge and narrower than the window.
 *
 * The committed set holds captures of both shapes — `repos-section-mounted-gate` spans
 * the full 1440 and `approvals-pane-live` is 1438 — and an element inset from the page
 * is the one the clip arithmetic can get wrong in a way a full-width element hides. So
 * the probe is the inset shape.
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
 * The image the matcher wrote, taken from the failure that named it.
 *
 * From the matcher's own message rather than rebuilt out of configuration: the
 * attachments directory is not on the serialized config a page can read, and a path
 * this file GUESSED could match a file some earlier run left behind — which is a probe
 * that passes against the wrong image. The label is matched, then the first absolute
 * path after it, skipping whatever colouring the reporter wrapped it in (an escape
 * sequence carries no `/`).
 */
function writtenCapturePath(failureMessage: string): string {
  const found = /Reference screenshot:[^/]*(\/[\w./+@-]*\.png)/u.exec(failureMessage);
  const path = found?.[1];
  if (path === undefined) {
    throw new Error(`the capture failure named no written image:\n${failureMessage}`);
  }
  return path;
}

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

/** Take the capture the chokepoint refuses to match, and hand back what it said. */
async function captureAgainstNoReference(element: Element): Promise<string> {
  const thrown: unknown = await captureSettled(element, UNCOMMITTED_REFERENCE_NAME).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(thrown instanceof Error)) {
    throw new Error(
      "the capture matched something: this probe's reference name must never be committed",
    );
  }
  expect(thrown.message).toMatch(/No existing reference screenshot found/u);
  return thrown.message;
}

describe("the screenshot tier's capture reaches the whole element", () => {
  afterEach(() => {
    for (const leftOver of document.body.querySelectorAll("div")) {
      leftOver.remove();
    }
  });

  it("photographs every row of a surface taller than the window", async (context) => {
    // Under `all` the matcher writes and passes, which would commit this probe's
    // rectangle as a baseline. The claim is about capture rather than about pixels
    // anyone approved, so it is made only where nothing is being minted.
    context.skip(
      screenshotUpdateMode !== "none",
      `this probe captures under a name nothing commits, so it is only safe while references are frozen; this run resolved "${screenshotUpdateMode}"`,
    );

    const surface = mountTallProbeSurface();
    const windowHeightBefore = window.innerHeight;

    const image = await CapturedPng.read(
      writtenCapturePath(await captureAgainstNoReference(surface)),
    );

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

  it("puts the window back after a capture that grew it", async (context) => {
    // The other half of the fix, and the half a pixel assertion cannot see: a capture
    // that opened the window and left it open hands the next spec a console laid out
    // at 2 400 px, and every reference after it in the file is a different surface.
    context.skip(
      screenshotUpdateMode !== "none",
      `this probe captures under a name nothing commits, so it is only safe while references are frozen; this run resolved "${screenshotUpdateMode}"`,
    );

    const surface = mountTallProbeSurface();
    const windowBefore = { width: window.innerWidth, height: window.innerHeight };

    await captureAgainstNoReference(surface);

    expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual(windowBefore);
  });
});

describe("the reader that finds the written capture", () => {
  it("takes the path out of a failure that names one", () => {
    expect(
      writtenCapturePath(
        "No existing reference screenshot found.\n\nReference screenshot:\n  /repo/apps/desktop/.vitest-attachments/a/b.test.ts/name-reference-chromium-darwin.png\n",
      ),
    ).toBe("/repo/apps/desktop/.vitest-attachments/a/b.test.ts/name-reference-chromium-darwin.png");
  });

  it("refuses a failure that names none rather than reading some other file", () => {
    // The planted failure. Without it the probe above would pass on a message shape
    // change by reading whichever `.png` path happened to be in the text.
    expect(() => {
      writtenCapturePath("Screenshot does not match the stored reference.");
    }).toThrowError(/named no written image/u);
  });
});
