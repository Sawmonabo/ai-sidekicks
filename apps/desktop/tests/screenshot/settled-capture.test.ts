// The capture refusal's own controls. A clean result is worth nothing without a planted failure:
// `assertNoPendingPaneBodies` fires on a state the tier is otherwise green under. The first suite
// drives that pure half (`captureSettled` composes it with a DOM read that has its own controls
// in `components/LazyBody/pending-body-marker.test.ts`). The second runs the real `CaptureWindow`
// against the real DOM read and fakes only the tester window, so the restore ordering can be
// driven through a settle that rejects. The third is the stability wait end to end: the ratio
// this class reports and the budget `capture-viewport.ts` derives from it, with the arithmetic's
// arms in `capture-viewport.test.ts`.

import { afterEach, describe, expect, it } from "vitest";

import {
  STABILITY_WAIT_PER_VIEWPORT_MS,
  stabilityWaitMsFor,
  type CaptureViewport,
} from "./capture-viewport.js";
import {
  assertNoPendingPaneBodies,
  CaptureWindow,
  type CaptureWindowDriver,
} from "./settled-capture.js";

/** What the fake window throws when it is asked to settle and told to fail. */
const SETTLE_REJECTION = "the element threw while settling the resize";

/** What it throws when the resize itself fails, part-way through moving the window. */
const RESIZE_REJECTION = "the tester window could not be resized";

/** How many windows tall the growing probe is: enough to need one, well under the ceiling. */
const PROBE_WINDOWS_TALL = 2;

/**
 * The height of the element `tall-capture.test.ts` holds whole, which failed with "Could not
 * capture a stable screenshot within 5000ms" on a loaded runner. Its width is not restated: a
 * capture never widens its window, so the window a hold ends on differs from the tier's in height
 * alone.
 */
const TALL_CAPTURE_PROBE_HEIGHT_PX = 2400;

/** Which call of each kind rejects, one-based, and `undefined` for a driver that never does. */
interface WindowDriverRejections {
  readonly resizeRejectsOnCall?: number;
  readonly settleRejectsOnCall?: number;
}

/**
 * The tester window, recorded rather than moved. A stand-in for the window only: `CaptureWindow`,
 * the sizing rule and the measured element are real, and what is faked is `page.viewport` and the
 * act-wrapped settle behind it, whose failure cannot be arranged.
 */
class RecordingWindowDriver implements CaptureWindowDriver {
  readonly #rejections: WindowDriverRejections;
  readonly #resizedTo: CaptureViewport[] = [];
  #resizeCalls = 0;
  #settleCalls = 0;

  public constructor(rejections: WindowDriverRejections = {}) {
    this.#rejections = rejections;
  }

  /** Every size the window was told to take, in the order it was told. */
  public get resizedTo(): readonly CaptureViewport[] {
    return this.#resizedTo;
  }

  public async resize(viewport: CaptureViewport): Promise<void> {
    this.#resizeCalls += 1;
    this.#resizedTo.push(viewport);
    await Promise.resolve();
    if (this.#resizeCalls === this.#rejections.resizeRejectsOnCall) {
      throw new Error(RESIZE_REJECTION);
    }
  }

  public async settle(): Promise<void> {
    this.#settleCalls += 1;
    await Promise.resolve();
    if (this.#settleCalls === this.#rejections.settleRejectsOnCall) {
      throw new Error(SETTLE_REJECTION);
    }
  }
}

/** The window a capture starts from, read the way `captureSettled` reads it. */
function testerWindow(): CaptureViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * An element of a stated height at the document's origin, half the window wide so its measured
 * box is its own size: `requiredViewportFor` reads the document-space bottom-right corner, and an
 * inset or full-width probe would assert clip arithmetic that `tall-capture.test.ts` reads from
 * the captured pixels.
 */
function mountElementOfHeightPx(heightPx: number, startedAt: CaptureViewport): HTMLElement {
  const element = document.createElement("div");
  element.style.position = "absolute";
  element.style.top = "0";
  element.style.left = "0";
  element.style.width = `${String(Math.floor(startedAt.width / 2))}px`;
  element.style.height = `${String(heightPx)}px`;
  document.body.append(element);
  return element;
}

// One cleanup hook at file scope for the two suites that mount elements into the same document.
afterEach(() => {
  for (const leftOver of document.body.querySelectorAll("div")) {
    leftOver.remove();
  }
});

describe("the screenshot tier's pending-body refusal", () => {
  it("passes a capture whose panes have all loaded", () => {
    expect(() => {
      assertNoPendingPaneBodies([], "repos-diff-pane-light");
    }).not.toThrow();
  });

  // The planted failure: one pending kind, the smallest bad input.
  it("refuses a capture with one pending pane body, and names the kind", () => {
    expect(() => {
      assertNoPendingPaneBodies(["workflow-run"], "workflows-run-pane-light");
    }).toThrowError(/workflow-run/u);
  });

  // The capture name is in the message so a failure says which of the tier's captures was taken.
  it("names the capture it refused", () => {
    expect(() => {
      assertNoPendingPaneBodies(["diff"], "repos-diff-pane-dark");
    }).toThrowError(/repos-diff-pane-dark/u);
  });

  it("counts every pending body rather than reporting the first", () => {
    expect(() => {
      assertNoPendingPaneBodies(["diff", "inspector"], "repos-section-light");
    }).toThrowError(/2 pane body\/bodies/u);
  });
});

describe("the tester window a capture opens", () => {
  it("puts the window back when the settle after a resize rejects", async () => {
    // The resize lands, the element throws while React flushes the layout it caused, and the
    // window is left open; a `restore` gated on a flag written after that settle returns early,
    // and every later capture is taken in an enlarged console.
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver({ settleRejectsOnCall: 1 });
    const captureWindow = new CaptureWindow(startedAt, driver);
    const element = mountElementOfHeightPx(startedAt.height * PROBE_WINDOWS_TALL, startedAt);

    await expect(captureWindow.holdWhole(element, "settle-rejects-probe")).rejects.toThrowError(
      SETTLE_REJECTION,
    );
    await captureWindow.restore();

    expect(driver.resizedTo).toStrictEqual([
      { width: startedAt.width, height: startedAt.height * PROBE_WINDOWS_TALL },
      startedAt,
    ]);
  });

  it("puts the window back when the resize itself rejects part-way", async () => {
    // One step earlier: a resize that throws leaves the window at no nameable size, so the flag
    // is raised before the call.
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver({ resizeRejectsOnCall: 1 });
    const captureWindow = new CaptureWindow(startedAt, driver);
    const element = mountElementOfHeightPx(startedAt.height * PROBE_WINDOWS_TALL, startedAt);

    await expect(captureWindow.holdWhole(element, "resize-rejects-probe")).rejects.toThrowError(
      RESIZE_REJECTION,
    );
    await captureWindow.restore();

    expect(driver.resizedTo).toStrictEqual([
      { width: startedAt.width, height: startedAt.height * PROBE_WINDOWS_TALL },
      startedAt,
    ]);
  });

  // The planted control: a `restore` that resizes unconditionally satisfies both cases above but
  // would charge one resize and one settle to every capture that never moved the window.
  it("leaves the window alone when the capture never moved it", async () => {
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver();
    const captureWindow = new CaptureWindow(startedAt, driver);
    const element = mountElementOfHeightPx(Math.floor(startedAt.height / 2), startedAt);

    await captureWindow.holdWhole(element, "fits-in-the-window-probe");
    await captureWindow.restore();

    expect(driver.resizedTo).toStrictEqual([]);
  });
});

describe("the stability wait a capture is given for the window it held", () => {
  it("gives a capture that fitted the tier's own wait", async () => {
    // The unchanged capture, most of the set: an element inside the window opens nothing, holds
    // one window, and gets the five seconds the tier has always given.
    const startedAt = testerWindow();
    const captureWindow = new CaptureWindow(startedAt, new RecordingWindowDriver());
    const element = mountElementOfHeightPx(Math.floor(startedAt.height / 2), startedAt);

    await captureWindow.holdWhole(element, "fits-in-the-window-probe");

    expect(stabilityWaitMsFor(captureWindow.heldViewportRatio)).toBe(
      STABILITY_WAIT_PER_VIEWPORT_MS,
    );
  });

  // The measured failure, end to end: raced against a flat five seconds, this capture read a
  // static element as unstable on a loaded runner.
  it("gives the tall probe's own geometry more than one window's wait", async () => {
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver();
    const captureWindow = new CaptureWindow(startedAt, driver);
    const element = mountElementOfHeightPx(TALL_CAPTURE_PROBE_HEIGHT_PX, startedAt);

    await captureWindow.holdWhole(element, "tall-capture-probe");

    // The hold is asserted first, so a large wait from a window that was never opened fails here
    // with the sizes.
    expect(driver.resizedTo).toStrictEqual([
      { width: startedAt.width, height: TALL_CAPTURE_PROBE_HEIGHT_PX },
    ]);
    expect(stabilityWaitMsFor(captureWindow.heldViewportRatio)).toBeGreaterThan(
      STABILITY_WAIT_PER_VIEWPORT_MS,
    );
  });

  // The control on the other side of the seam: a ratio read off the window the hold climbed to,
  // not the one left applied, would still report the tall probe's windows and overcharge every
  // later capture.
  it("reports one window again once the capture has put the window back", async () => {
    const startedAt = testerWindow();
    const captureWindow = new CaptureWindow(startedAt, new RecordingWindowDriver());
    const element = mountElementOfHeightPx(TALL_CAPTURE_PROBE_HEIGHT_PX, startedAt);

    await captureWindow.holdWhole(element, "tall-capture-probe");
    await captureWindow.restore();

    expect(stabilityWaitMsFor(captureWindow.heldViewportRatio)).toBe(
      STABILITY_WAIT_PER_VIEWPORT_MS,
    );
  });
});
