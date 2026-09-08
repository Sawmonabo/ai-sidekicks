// The capture-window rule's own controls.
//
// The rule decides four things and two of them are refusals, so a suite that only
// ever handed it a surface which already fits would prove what a function returning
// one arm unconditionally proves. Every case here drives the real rule; the DOM
// read that produces its `required` argument is `settled-capture.ts`'s and has the
// probe in `tall-capture.test.ts` behind it, which reads the captured pixels rather
// than the arithmetic.
//
// THE THIRD ARM IS DRIVEN ON BOTH SIDES OF ITS CONFIRMATION. A surface sized by its
// window and a surface that reflowed once while the first window was opening show the
// SAME non-closing overhang on one observation, and the pair of cases below is what
// keeps them apart: the reflow is grown for and then fits, the coupled surface hangs
// over by the same constant again and takes the arm. A rule that armed on the first
// observation passes every other case in this file.
//
// AND THE SECOND SUITE DRIVES WHAT THAT WINDOW COSTS IN TIME. The stability wait is
// the same window read as work, so its cases sit beside the sizing ones. All three
// turn on one rounding, which is exactly the shape a suite of whole-number inputs
// would report clean on: one holds the wait a capture that fits has always had, one
// asks what a fractional hold buys, and one asks what a hold SMALLER than the window
// does — the case that separates rounding up from rounding down, and the only one
// that would notice a small capture being given a fraction of the tier's wait.

import { describe, expect, it } from "vitest";

import {
  CAPTURE_WINDOW_HEIGHT_CEILING,
  captureWindowStep,
  STABILITY_WAIT_PER_VIEWPORT_MS,
  stabilityWaitMsFor,
} from "./capture-viewport.js";

/** The window the console is measured in, which every case starts from. */
const CONSOLE_WINDOW = { width: 1440, height: 900 };

describe("the window a capture opens", () => {
  it("leaves a surface that already fits alone", () => {
    expect(
      captureWindowStep(CONSOLE_WINDOW, { width: 1440, height: 900 }, [], "frame-first-run-light"),
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
        [],
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({
      kind: "grow",
      viewport: { width: 1440, height: 2050 },
      overhangPx: 1150,
    });
  });

  it("grows again while the overhang is still closing", () => {
    // A surface that answered the first grow with a taller box — a deferred image
    // landed, a container reflowed — is still worth growing for, because the gap it
    // leaves is smaller than the one before it.
    expect(
      captureWindowStep(
        { width: 1440, height: 2050 },
        { width: 1440, height: 2090 },
        [1150],
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({ kind: "grow", viewport: { width: 1440, height: 2090 }, overhangPx: 40 });
  });

  it("grows for an overhang that failed to close on its first showing", () => {
    // THE MISREAD THIS COSTS, and the reason the arm below is confirmed rather than
    // taken. A grow is itself a layout change, so a deferred image can land during the
    // settle and add back as much as the window just gained: the box was 2 050 in a
    // 900 px window, the window opened to 2 050, and the image took it to 3 250. One
    // non-closing overhang is all a surface sized BY its window shows either, and
    // reading this one as that put the window back and photographed the surface with
    // 1 200 px of unpainted tail — the defect the whole module exists to refuse.
    expect(
      captureWindowStep(
        { width: 1440, height: 2050 },
        { width: 1440, height: 3250 },
        [1150],
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({ kind: "grow", viewport: { width: 1440, height: 3250 }, overhangPx: 1200 });
  });

  it("reports that surface as fitting on the pass the second grow buys", () => {
    // The other half of the same claim: the surface that was misread is now in a
    // window that holds it, which is the capture the arm was replacing with a restored
    // window and a blank band.
    expect(
      captureWindowStep(
        { width: 1440, height: 3250 },
        { width: 1440, height: 3250 },
        [1150, 1200],
        "repos-section-mounted-gate-light",
      ),
    ).toStrictEqual({ kind: "fits" });
  });

  it("stops on a surface whose overhang did not close twice over, and says how far it hangs", () => {
    // The console's two full-height destinations: `min-height: 100%` around 32px of
    // their own padding, so each measures 64px past whatever window it is in — at 900,
    // at 964, and again at 1 028. That third measurement is what separates them from
    // the reflow above. The arm carries the overhang because that figure is the whole
    // claim — it is the band no window paints, and it is the surface's padding rather
    // than its content.
    expect(
      captureWindowStep(
        { width: 1440, height: 1028 },
        { width: 1440, height: 1092 },
        [64, 64],
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
        { width: 1440, height: 1100 },
        { width: 1440, height: 1236 },
        [64, 100],
        "collaboration-settings-dark",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 136 });
  });

  it("refuses a surface taller than the ceiling, naming both figures", () => {
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING + 1 },
        [],
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
        [],
        "tall-light",
      ),
    ).toStrictEqual({
      kind: "grow",
      viewport: { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING },
      overhangPx: CAPTURE_WINDOW_HEIGHT_CEILING - CONSOLE_WINDOW.height,
    });
  });

  it("refuses a suspected coupling whose confirming grow would pass the ceiling", () => {
    // The order the rule states, on the side that is still a guess: a surface that has
    // hung over ONCE is not yet known to track its window, and exempting it from the
    // ceiling to spare it the second grow is the misread above wearing the arm's name.
    // So a confirming grow is bounded like any other, and the refusal names the height.
    expect(() => {
      captureWindowStep(
        { width: 1440, height: 2900 },
        { width: 1440, height: 4900 },
        [2000],
        "workflows-run-pane-light",
      );
    }).toThrowError(/4900px tall/u);
  });

  it("takes the third arm on a confirmed coupling the ceiling would have refused", () => {
    // And the side that is not a guess. Two non-closing overhangs prove no window
    // holds this surface, so it is photographed at the tier's own window — where it is
    // nowhere near the ceiling — rather than refused for a height it only ever has in
    // the window the loop climbed to.
    expect(
      captureWindowStep(
        { width: 1440, height: 2900 },
        { width: 1440, height: 4900 },
        [2000, 2000],
        "collaboration-sessions-dark",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 2000 });
  });

  it("refuses a surface wider than the window rather than widening it", () => {
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1441, height: 400 },
        [],
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
        [],
        "approvals-pane-live-dark",
      );
    }).toThrowError(/approvals-pane-live-dark/u);
  });
});

describe("how long a capture of that window is given to settle", () => {
  it("gives a viewport-sized capture the tier's own wait", () => {
    // The unchanged case, and the reason this is a multiplier rather than a raise:
    // every reference that fits in the window is still compared under exactly the
    // five seconds it has always had, so nothing about a capture that was never slow
    // is being made more patient.
    expect(stabilityWaitMsFor(1)).toBe(STABILITY_WAIT_PER_VIEWPORT_MS);
  });

  it("rounds a fractional hold up to the whole window it does work in", () => {
    // 2.05 windows is three windows of encoding and three of comparison in whichever
    // pass reaches the last rows, so the budget is three windows' worth. A rule that
    // rounded down would fund 2 of the 2.05 and fail on the fraction it did not.
    expect(stabilityWaitMsFor(2.05)).toBe(STABILITY_WAIT_PER_VIEWPORT_MS * 3);
  });

  it("gives a capture smaller than the window the whole wait rather than a fraction", () => {
    // The floor, which the rounding is rather than something written beside it. A
    // surface half a window tall is `0.5`, and a rule that multiplied by it — or that
    // rounded the other way — would hand a small capture a fraction of the wait the
    // tier has always given it, so a change meant to make one class of capture more
    // patient would quietly make every small one less so. Planted: rounding DOWN here
    // gives 0 ms, and this is the only case that says so.
    expect(stabilityWaitMsFor(0.5)).toBe(STABILITY_WAIT_PER_VIEWPORT_MS);
  });
});
