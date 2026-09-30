// The capture-window rule's own controls. The rule decides four things, two of them refusals, so
// every case drives the real rule with inputs that reach each arm. The DOM read that produces its
// `required` argument is `settled-capture.ts`'s, with a pixel probe in `tall-capture.test.ts`.
//
// The third arm is driven on both sides of its confirmation. An element sized by its window and
// one that reflowed once while the first window was opening show the same non-closing overhang on
// one observation; the pair of cases keeps them apart, and a rule that armed on the first
// observation passes every other case.
//
// The wait suite drives what the window costs in time. All three cases turn on one rounding,
// which whole-number inputs would report clean on: the wait of a capture that fits, a fractional
// hold, and a hold smaller than the window (which separates rounding up from rounding down).

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
  it("leaves an element that already fits alone", () => {
    expect(
      captureWindowStep(CONSOLE_WINDOW, { width: 1440, height: 900 }, [], "frame-first-run-light"),
    ).toStrictEqual({ kind: "fits" });
  });

  it("grows to an element taller than the window, keeping the width", () => {
    // The width is carried, not taken from `required`: a capture never widens its window, and an
    // element narrower than the page must not shrink it, or the console would relayout.
    expect(
      captureWindowStep(CONSOLE_WINDOW, { width: 1200, height: 2050 }, [], "repos-diff-pane-light"),
    ).toStrictEqual({
      kind: "grow",
      viewport: { width: 1440, height: 2050 },
      overhangPx: 1150,
    });
  });

  it("grows again while the overhang is still closing", () => {
    // An element that answered the first grow with a taller box (a deferred image landed, a
    // container reflowed) is still worth growing for, since its gap is smaller than before.
    expect(
      captureWindowStep(
        { width: 1440, height: 2050 },
        { width: 1440, height: 2090 },
        [1150],
        "repos-diff-pane-light",
      ),
    ).toStrictEqual({ kind: "grow", viewport: { width: 1440, height: 2090 }, overhangPx: 40 });
  });

  it("grows for an overhang that failed to close on its first showing", () => {
    // A grow is itself a layout change: a deferred image can land during the settle and add back
    // as much as the window gained (box 2 050 in a 900 px window, window opened to 2 050, image
    // took it to 3 250). One non-closing overhang is also what an element sized by its window
    // shows, and reading it as that would restore the window and photograph 1 200 px of unpainted
    // tail.
    expect(
      captureWindowStep(
        { width: 1440, height: 2050 },
        { width: 1440, height: 3250 },
        [1150],
        "repos-diff-pane-light",
      ),
    ).toStrictEqual({ kind: "grow", viewport: { width: 1440, height: 3250 }, overhangPx: 1200 });
  });

  it("reports that element as fitting on the pass the second grow buys", () => {
    // The misread element now sits in a window that holds it.
    expect(
      captureWindowStep(
        { width: 1440, height: 3250 },
        { width: 1440, height: 3250 },
        [1150, 1200],
        "repos-diff-pane-light",
      ),
    ).toStrictEqual({ kind: "fits" });
  });

  it("stops on an element whose overhang did not close twice over, and says how far it hangs", () => {
    // The console's two full-height destinations are `min-height: 100%` around 32px of padding,
    // so each measures 64px past whatever window it is in (at 900, 964 and 1 028). The third
    // measurement separates them from the reflow above. The arm carries the overhang because it
    // is the band no window paints, and it is the element's padding, not its content.
    expect(
      captureWindowStep(
        { width: 1440, height: 1028 },
        { width: 1440, height: 1092 },
        [64, 64],
        "sessions-light",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 64 });
  });

  it("stops on an element whose overhang grew rather than closing", () => {
    // `>=` rather than `===`: an element that hangs over further after a grow tracks its window
    // at more than 1:1, and chasing it is how a loop reaches the ceiling on an element nothing
    // would hold.
    expect(
      captureWindowStep(
        { width: 1440, height: 1100 },
        { width: 1440, height: 1236 },
        [64, 100],
        "settings-dark",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 136 });
  });

  it("refuses an element taller than the ceiling, naming both figures", () => {
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: CAPTURE_WINDOW_HEIGHT_CEILING + 1 },
        [],
        "workflows-run-pane-light",
      );
    }).toThrowError(new RegExp(`${String(CAPTURE_WINDOW_HEIGHT_CEILING + 1)}px tall`, "u"));
  });

  it("takes an element of exactly the ceiling", () => {
    // The boundary in the direction that matters: `>=` would refuse the tallest window the rule
    // opens.
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
    // An element that has hung over once is not yet known to track its window, and exempting it
    // from the ceiling would be the misread above. A confirming grow is bounded like any other,
    // and the refusal names the height.
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
    // The side that is not a guess: two non-closing overhangs prove no window holds this element,
    // so it is photographed at the tier's own window rather than refused for a height it only has
    // in the window the loop climbed to.
    expect(
      captureWindowStep(
        { width: 1440, height: 2900 },
        { width: 1440, height: 4900 },
        [2000, 2000],
        "sessions-dark",
      ),
    ).toStrictEqual({ kind: "grows-with-its-window", overhangPx: 2000 });
  });

  it("refuses an element wider than the window rather than widening it", () => {
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1441, height: 400 },
        [],
        "composer-session-default-light",
      );
    }).toThrowError(/1441px across a 1440px window/u);
  });

  it("names the capture in every refusal", () => {
    // A tier that pins dozens of captures has no other way to say which one was being taken.
    expect(() => {
      captureWindowStep(
        CONSOLE_WINDOW,
        { width: 1440, height: 99_999 },
        [],
        "repos-diff-pane-dark",
      );
    }).toThrowError(/repos-diff-pane-dark/u);
  });
});

describe("how long a capture of that window is given to settle", () => {
  it("gives a viewport-sized capture the tier's own wait", () => {
    // The unchanged case, and why this is a multiplier rather than a raise: a capture that fits
    // keeps the five seconds it always had.
    expect(stabilityWaitMsFor(1)).toBe(STABILITY_WAIT_PER_VIEWPORT_MS);
  });

  it("rounds a fractional hold up to the whole window it does work in", () => {
    // 2.05 windows is three windows of encoding and comparison in whichever pass reaches the last
    // rows; rounding down would fund 2 and fail on the fraction.
    expect(stabilityWaitMsFor(2.05)).toBe(STABILITY_WAIT_PER_VIEWPORT_MS * 3);
  });

  it("gives a capture smaller than the window the whole wait rather than a fraction", () => {
    // The floor is the rounding itself. A half-window element has ratio 0.5, and multiplying by it
    // or rounding down would hand small captures a fraction of the wait. Rounding down gives 0 ms,
    // and this is the only case that says so.
    expect(stabilityWaitMsFor(0.5)).toBe(STABILITY_WAIT_PER_VIEWPORT_MS);
  });
});
