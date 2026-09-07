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
 * How far the window-derived surface below hangs past whatever window it is in.
 *
 * The console's two full-height destinations measure exactly this much past theirs —
 * `min-height: 100%` around 32px of their own padding — so the probe reproduces the
 * shape with the arithmetic written out rather than inherited from a layout.
 */
const PROBE_OVERHANG_PX = 64;

/** The label the matcher writes the reference's path under, on the line below it. */
const CAPTURE_PATH_LABEL = "Reference screenshot:";

/**
 * The colouring a reporter may have wrapped the path in.
 *
 * Matched through the escape's Unicode CATEGORY rather than through the character
 * itself, which is what `no-control-regex` refuses in a pattern and what an exemption
 * here would have to be censused for. The claim is the same one either way: an SGR
 * sequence is a control character, `[`, digits and semicolons, and a terminating `m`.
 */
const REPORTER_COLOURING = /\p{Cc}\[[0-9;]*m/gu;

/**
 * The image the matcher wrote, taken from the failure that named it.
 *
 * From the matcher's own message rather than rebuilt out of configuration: the
 * attachments directory is not on the serialized config a page can read, and a path
 * this file GUESSED could match a file some earlier run left behind — which is a probe
 * that passes against the wrong image.
 *
 * THE WHOLE LINE, NOT A CHARACTER CLASS. What the matcher prints is an absolute path
 * off the runner's own filesystem, and a character class is a claim about which
 * characters a path may hold that neither platform makes: a POSIX directory may carry
 * a space, and a Windows one is `C:\…\name.png` with not one forward slash in it. A
 * class that admits neither does not fail on the path — it fails to find one, and this
 * probe then reports a message shape rather than the image it could not read. So the
 * label is found, the first non-empty line after it is taken whole and trimmed, and
 * `.png` is asserted on what comes back.
 *
 * AND THE SCAN STOPS AT THAT LINE. The same message names the ACTUAL capture a few
 * lines further down, so a reader that kept looking would answer a reference it could
 * not read with a different image and assert this probe's colours against it.
 */
function writtenCapturePath(failureMessage: string): string {
  const labelAt = failureMessage.indexOf(CAPTURE_PATH_LABEL);
  const afterLabel =
    labelAt === -1 ? "" : failureMessage.slice(labelAt + CAPTURE_PATH_LABEL.length);
  for (const line of afterLabel.split("\n")) {
    const candidate = line.replaceAll(REPORTER_COLOURING, "").trim();
    if (candidate.length === 0) {
      continue;
    }
    if (candidate.endsWith(".png")) {
      return candidate;
    }
    break;
  }
  throw new Error(`the capture failure named no written image:\n${failureMessage}`);
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

  it("photographs a window-derived surface at the tier's own window", async (context) => {
    // The one shape growing cannot fix, and the reason the chokepoint stops instead
    // of chasing: this surface is one window tall plus 64px at EVERY window, so each
    // grow moves both numbers together. The claim is that the capture is taken at
    // the size the tier configures — not at whatever the loop climbed to — and that
    // the unpainted band is exactly the overhang and nothing more.
    context.skip(
      screenshotUpdateMode !== "none",
      `this probe captures under a name nothing commits, so it is only safe while references are frozen; this run resolved "${screenshotUpdateMode}"`,
    );

    const surface = mountWindowDerivedProbeSurface();
    const windowBefore = { width: window.innerWidth, height: window.innerHeight };

    const image = await CapturedPng.read(
      writtenCapturePath(await captureAgainstNoReference(surface)),
    );

    expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual(windowBefore);
    expect(image.height).toBe(windowBefore.height + PROBE_OVERHANG_PX);

    // Painted to the window's last row, and the page's background for the overhang
    // below it. Asserting the band rather than eliding it is the point: it is the
    // residual this arm accepts, it is bounded by the surface's own padding, and a
    // change in its size fails here rather than appearing in a reference nobody
    // looks at the bottom of.
    expect(image.rowColours(windowBefore.height - 1)).toStrictEqual([PROBE_FIELD_COLOUR]);
    expect(image.rowColours(image.height - 1)).toStrictEqual([PAGE_BACKGROUND_COLOUR]);
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

  it("takes a path whose directories hold spaces", () => {
    // A runner's home directory is not this repository's to choose, and a character
    // class that admitted no space read nothing at all on a host that had one.
    expect(
      writtenCapturePath(
        "Reference screenshot:\n  /Users/ci runner/apps/desktop/.vitest-attachments/a b.test.ts/name-reference-chromium-darwin.png\n",
      ),
    ).toBe(
      "/Users/ci runner/apps/desktop/.vitest-attachments/a b.test.ts/name-reference-chromium-darwin.png",
    );
  });

  it("takes a Windows path, which carries no forward slash to anchor on", () => {
    expect(
      writtenCapturePath(
        "Reference screenshot:\n  C:\\Users\\runneradmin\\desktop\\.vitest-attachments\\a.test.ts\\name-reference-chromium-win32.png\n",
      ),
    ).toBe(
      "C:\\Users\\runneradmin\\desktop\\.vitest-attachments\\a.test.ts\\name-reference-chromium-win32.png",
    );
  });

  it("reads through the colouring the reporter wraps the path in", () => {
    expect(
      writtenCapturePath("Reference screenshot:\n  \u001b[32m/repo/a-reference.png\u001b[39m\n"),
    ).toBe("/repo/a-reference.png");
  });

  it("refuses a failure that names none rather than reading some other file", () => {
    // The planted failure. Without it the probe above would pass on a message shape
    // change by reading whichever `.png` path happened to be in the text.
    expect(() => {
      writtenCapturePath("Screenshot does not match the stored reference.");
    }).toThrowError(/named no written image/u);
  });

  it("refuses a reference line that is not a path rather than reading the actual one", () => {
    // The second planted failure, and the reason the scan stops at the first non-empty
    // line: the actual capture is named in the same message, and a reader that walked
    // on would assert this probe's colours against a different image.
    expect(() => {
      writtenCapturePath(
        "Reference screenshot:\n  (none written)\n\nActual screenshot:\n  /repo/an-actual.png\n",
      );
    }).toThrowError(/named no written image/u);
  });
});
