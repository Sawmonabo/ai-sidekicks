// The capture-window rule's own controls.
//
// The rule decides three things and two of them are refusals, so a suite that only
// ever handed it a surface which already fits would prove what a function returning
// `undefined` unconditionally proves. Every case here drives the real rule; the DOM
// read that produces its `required` argument is `settled-capture.ts`'s and has the
// probe in `tall-capture.test.ts` behind it, which reads the captured pixels rather
// than the arithmetic.

import { describe, expect, it } from "vitest";

import { CAPTURE_WINDOW_HEIGHT_CEILING, captureViewportFor } from "./capture-viewport.js";

/** The window the console is measured in, which every case starts from. */
const CONSOLE_WINDOW = { width: 1440, height: 900 };

describe("the window a capture opens", () => {
  it("leaves a surface that already fits alone", () => {
    expect(
      captureViewportFor(CONSOLE_WINDOW, { width: 1440, height: 900 }, "frame-first-run-light"),
    ).toBeUndefined();
  });

  it("grows to a surface taller than the window, keeping the width", () => {
    // The width is carried rather than taken from `required`: a capture never widens
    // its window, and a surface narrower than the page must not shrink it either —
    // the console would relayout and the reference would pin a different surface.
    expect(
      captureViewportFor(
        CONSOLE_WINDOW,
        { width: 1200, height: 2050 },
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({ width: 1440, height: 2050 });
  });

  it("refuses a surface taller than the ceiling, naming both figures", () => {
    expect(() => {
      captureViewportFor(
        CONSOLE_WINDOW,
        { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING + 1 },
        "workflows-run-pane-light",
      );
    }).toThrowError(new RegExp(`${String(CAPTURE_WINDOW_HEIGHT_CEILING + 1)}px tall`, "u"));
  });

  it("takes a surface of exactly the ceiling", () => {
    // The boundary in the direction that matters: a rule written with `>=` would
    // refuse the tallest window it is built to open.
    expect(
      captureViewportFor(
        CONSOLE_WINDOW,
        { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING },
        "tall-light",
      ),
    ).toStrictEqual({ width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING });
  });

  it("refuses a surface wider than the window rather than widening it", () => {
    expect(() => {
      captureViewportFor(
        CONSOLE_WINDOW,
        { width: 1441, height: 400 },
        "composer-channel-default-light",
      );
    }).toThrowError(/1441px across a 1440px window/u);
  });

  it("names the reference in every refusal", () => {
    // A tier that pins dozens of references reports a failure with no other way to
    // say which one was being taken.
    expect(() => {
      captureViewportFor(
        CONSOLE_WINDOW,
        { width: 1440, height: 99_999 },
        "approvals-pane-live-dark",
      );
    }).toThrowError(/approvals-pane-live-dark/u);
  });
});
