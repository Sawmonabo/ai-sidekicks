// The capture-window rule's own controls.
//
// The rule decides four things and two of them are refusals, so a suite that only
// ever handed it a surface which already fits would prove what a function returning
// one arm unconditionally proves. Every case here drives the real rule; the DOM
// read that produces its `required` argument is `settled-capture.ts`'s and has the
// probe in `tall-capture.test.ts` behind it, which reads the captured pixels rather
// than the arithmetic.

import { describe, expect, it } from "vitest";

import { CAPTURE_WINDOW_HEIGHT_CEILING, captureWindowStep } from "./capture-viewport.js";

/** The window the console is measured in, which every case starts from. */
const CONSOLE_WINDOW = { width: 1440, height: 900 };

describe("the window a capture opens", () => {
  it("leaves a surface that already fits alone", () => {
    expect(
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: 900 },
        undefined,
        "frame-first-run-light",
      ),
    ).toStrictEqual({ kind: "fits" });
  });

  it("grows to a surface taller than the window, keeping the width", () => {
    // The width is carried rather than taken from `required`: a capture never widens
    // its window, and a surface narrower than the page must not shrink it either —
    // the console would relayout and the reference would pin a different surface.
    expect(
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1200, height: 2050 },
        undefined,
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({ kind: "grow", viewport: { width: 1440, height: 2050 } });
  });

  it("grows again while the overhang is still closing", () => {
    // A surface that answered the first grow with a taller box — a deferred image
    // landed, a container reflowed — is still worth growing for, because the gap it
    // leaves is smaller than the one before it.
    expect(
      captureWindowStep(
        { width: 1440, height: 2050 },
        { width: 1440, height: 2090 },
        1150,
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({ kind: "grow", viewport: { width: 1440, height: 2090 } });
  });

  it("stops on a surface whose overhang did not close, and says how far it hangs", () => {
    // The console's two full-height destinations: `min-height: 100%` around 32px of
    // their own padding, so each measures 64px past whatever window it is in. The
    // arm carries the overhang because that figure is the whole claim — it is the
    // band no window paints, and it is the surface's padding rather than its content.
    expect(
      captureWindowStep(
        { width: 1440, height: 964 },
        { width: 1440, height: 1028 },
        64,
        "collaboration-sessions-light",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 64 });
  });

  it("stops on a surface whose overhang grew rather than closing", () => {
    // The other half of the same conjunct. `>=` rather than `===` because a surface
    // that hangs over FURTHER after a grow is tracking its window at more than 1:1,
    // and chasing that one is how a loop reaches the ceiling on a surface nothing
    // was ever going to hold.
    expect(
      captureWindowStep(
        { width: 1440, height: 964 },
        { width: 1440, height: 1100 },
        64,
        "collaboration-settings-dark",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 136 });
  });

  it("refuses a surface taller than the ceiling, naming both figures", () => {
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING + 1 },
        undefined,
        "workflows-run-pane-light",
      );
    }).toThrowError(new RegExp(`${String(CAPTURE_WINDOW_HEIGHT_CEILING + 1)}px tall`, "u"));
  });

  it("takes a surface of exactly the ceiling", () => {
    // The boundary in the direction that matters: a rule written with `>=` would
    // refuse the tallest window it is built to open.
    expect(
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING },
        undefined,
        "tall-light",
      ),
    ).toStrictEqual({
      kind: "grow",
      viewport: { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING },
    });
  });

  it("refuses a surface wider than the window rather than widening it", () => {
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1441, height: 400 },
        undefined,
        "composer-channel-default-light",
      );
    }).toThrowError(/1441px across a 1440px window/u);
  });

  it("names the reference in every refusal", () => {
    // A tier that pins dozens of references reports a failure with no other way to
    // say which one was being taken.
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: 99_999 },
        undefined,
        "approvals-pane-live-dark",
      );
    }).toThrowError(/approvals-pane-live-dark/u);
  });
});
