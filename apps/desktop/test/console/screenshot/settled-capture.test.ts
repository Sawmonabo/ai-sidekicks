// The capture refusal's own controls.
//
// A CLEAN RESULT IS WORTH NOTHING WITHOUT A PLANTED FAILURE, which is the package's
// rule and is doubly true here: the whole point of `assertNoPendingPaneBodies` is that
// it fires on a state the tier is otherwise green under, so a suite that only ever
// handed it an empty list would prove exactly what a function returning `undefined`
// unconditionally proves.
//
// THE PURE HALF IS WHAT IS DRIVEN. `captureSettled` composes the DOM read with this
// refusal; the read has its own controls beside the marker it reads
// (`console/seats/pane/pending-pane-body.test.ts`), and driving the composed function here
// would mean minting a real half-loaded capture, which is the thing it exists to
// prevent.
//
// AND THE WINDOW BOOKKEEPING IS DRIVEN THROUGH THE REAL CLASS. The second suite below
// runs `CaptureWindow` itself against the real DOM read, and fakes exactly one
// collaborator: the tester window. A settle rejects when an effect throws while React
// flushes the layout a resize caused — a state no capture can produce on demand — and
// that is the state the restore ordering exists for, so it is handed to the class
// rather than waited for.
//
// AND THE THIRD SUITE IS THE STABILITY WAIT, END TO END OVER THE SAME CLASS. What a
// capture is given to settle in is decided by what its window ended up holding, so the
// claim spans two modules — the ratio this class reports and the budget
// `capture-viewport.ts` derives from it — and driving them together is the only way to
// see the number a real capture would actually be handed. The arithmetic's own arms
// are `capture-viewport.test.ts`'s; what is proved here is that the tall probe's own
// geometry reaches this seam and comes back with more than one window's wait.

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
const SETTLE_REJECTION = "the surface threw while settling the resize";

/** What it throws when the resize itself fails, part-way through moving the window. */
const RESIZE_REJECTION = "the tester window could not be resized";

/** How many windows tall the growing probe is: enough to need one, well under the ceiling. */
const PROBE_WINDOWS_TALL = 2;

/**
 * The height of the surface `tall-capture.test.ts` holds whole, which is the failure.
 *
 * That probe photographs a 1 200 × 2 400 box, and on a loaded runner the capture of it
 * reported "Could not capture a stable screenshot within 5000ms" against a diff that
 * touched no renderer file. Its WIDTH is deliberately not reproduced here: a capture
 * never widens its window — `captureWindowStep` carries `applied.width` into every
 * grow it returns — so the window a hold ends on differs from the tier's in height
 * alone, and a width restated in this file would be a number that cannot change the
 * answer sitting in a case that looks like it depends on one.
 */
const TALL_CAPTURE_PROBE_HEIGHT_PX = 2400;

/** Which call of each kind rejects, one-based, and `undefined` for a driver that never does. */
interface WindowDriverRejections {
  readonly resizeRejectsOnCall?: number;
  readonly settleRejectsOnCall?: number;
}

/**
 * The tester window, recorded rather than moved.
 *
 * A stand-in for the WINDOW and not for the module under test: `CaptureWindow` is the
 * real class, the sizing rule it consults is the real one, and the box it measures is a
 * real element in this page. What is faked is the one collaborator whose failure cannot
 * be arranged — `page.viewport` and the act-wrapped settle behind it.
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
 * A surface of a stated height at the document's origin.
 *
 * Anchored at the origin and half the window wide so its measured box is its own size:
 * `requiredViewportFor` reads the DOCUMENT-space bottom-right corner, and a probe that
 * was inset or full-width would be asserting the clip arithmetic that
 * `tall-capture.test.ts` already reads out of the captured pixels.
 */
function mountSurfaceOfHeightPx(heightPx: number, startedAt: CaptureViewport): HTMLElement {
  const surface = document.createElement("div");
  surface.style.position = "absolute";
  surface.style.top = "0";
  surface.style.left = "0";
  surface.style.width = `${String(Math.floor(startedAt.width / 2))}px`;
  surface.style.height = `${String(heightPx)}px`;
  document.body.append(surface);
  return surface;
}

// One home for the mounted-probe cleanup, at file scope rather than repeated per
// suite: two suites below mount surfaces into the same document, and a second copy of
// this hook is the shape that goes stale the first time only one of them is edited.
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

  // The planted failure. One pending kind, which is the smallest bad input there is.
  it("refuses a capture with one pending pane body, and names the kind", () => {
    expect(() => {
      assertNoPendingPaneBodies(["workflow-run"], "workflows-run-pane-light");
    }).toThrowError(/workflow-run/u);
  });

  // The capture name is in the message because a tier that pins fourteen captures
  // reports a failure with no other way to say which one was being taken.
  it("names the capture it refused", () => {
    expect(() => {
      assertNoPendingPaneBodies(["diff"], "repos-diff-pane-dark");
    }).toThrowError(/repos-diff-pane-dark/u);
  });

  it("counts every pending body rather than reporting the first", () => {
    expect(() => {
      assertNoPendingPaneBodies(["diff", "artifact"], "repos-section-light");
    }).toThrowError(/2 pane body\/bodies/u);
  });
});

describe("the tester window a capture opens", () => {
  it("puts the window back when the settle after a resize rejects", async () => {
    // The failure the ordering exists for. The resize lands, the surface throws while
    // React flushes the layout it caused, and the window is left open — so a `restore`
    // gated on a flag written AFTER that settle returns early, and every later capture
    // in the run is taken in a console this one enlarged.
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver({ settleRejectsOnCall: 1 });
    const captureWindow = new CaptureWindow(startedAt, driver);
    const surface = mountSurfaceOfHeightPx(startedAt.height * PROBE_WINDOWS_TALL, startedAt);

    await expect(captureWindow.holdWhole(surface, "settle-rejects-probe")).rejects.toThrowError(
      SETTLE_REJECTION,
    );
    await captureWindow.restore();

    expect(driver.resizedTo).toStrictEqual([
      { width: startedAt.width, height: startedAt.height * PROBE_WINDOWS_TALL },
      startedAt,
    ]);
  });

  it("puts the window back when the resize itself rejects part-way", async () => {
    // The same claim one step earlier: a resize that throws has left the window at no
    // size anyone can name, so the flag is raised before the call rather than after it.
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver({ resizeRejectsOnCall: 1 });
    const captureWindow = new CaptureWindow(startedAt, driver);
    const surface = mountSurfaceOfHeightPx(startedAt.height * PROBE_WINDOWS_TALL, startedAt);

    await expect(captureWindow.holdWhole(surface, "resize-rejects-probe")).rejects.toThrowError(
      RESIZE_REJECTION,
    );
    await captureWindow.restore();

    expect(driver.resizedTo).toStrictEqual([
      { width: startedAt.width, height: startedAt.height * PROBE_WINDOWS_TALL },
      startedAt,
    ]);
  });

  // The planted control. Both cases above are satisfied by a `restore` that resizes
  // unconditionally, which is the lazy way to make them pass and which would put the
  // window back for every capture that never touched it — one resize and one settle
  // charged to each of the tier's captures. A capture that fits moves nothing.
  it("leaves the window alone when the capture never moved it", async () => {
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver();
    const captureWindow = new CaptureWindow(startedAt, driver);
    const surface = mountSurfaceOfHeightPx(Math.floor(startedAt.height / 2), startedAt);

    await captureWindow.holdWhole(surface, "fits-in-the-window-probe");
    await captureWindow.restore();

    expect(driver.resizedTo).toStrictEqual([]);
  });
});

describe("the stability wait a capture is given for the window it held", () => {
  it("gives a capture that fitted the tier's own wait", async () => {
    // The unchanged capture, which is most of the committed set: a surface inside the
    // window opens nothing, holds one window, and is compared under exactly the five
    // seconds this tier has always given it.
    const startedAt = testerWindow();
    const captureWindow = new CaptureWindow(startedAt, new RecordingWindowDriver());
    const surface = mountSurfaceOfHeightPx(Math.floor(startedAt.height / 2), startedAt);

    await captureWindow.holdWhole(surface, "fits-in-the-window-probe");

    expect(stabilityWaitMsFor(captureWindow.heldViewportRatio)).toBe(
      STABILITY_WAIT_PER_VIEWPORT_MS,
    );
  });

  // The measured failure, driven end to end. Before the wait was sized to the hold,
  // this capture was raced against the same five seconds as one a quarter its size,
  // and a static surface came back reported as unstable on a loaded runner.
  it("gives the tall probe's own geometry more than one window's wait", async () => {
    const startedAt = testerWindow();
    const driver = new RecordingWindowDriver();
    const captureWindow = new CaptureWindow(startedAt, driver);
    const surface = mountSurfaceOfHeightPx(TALL_CAPTURE_PROBE_HEIGHT_PX, startedAt);

    await captureWindow.holdWhole(surface, "tall-capture-probe");

    // The hold is asserted first, so a wait that came back large because the window
    // was never opened at all fails here with the sizes rather than there with a
    // number that looks right for the wrong reason.
    expect(driver.resizedTo).toStrictEqual([
      { width: startedAt.width, height: TALL_CAPTURE_PROBE_HEIGHT_PX },
    ]);
    expect(stabilityWaitMsFor(captureWindow.heldViewportRatio)).toBeGreaterThan(
      STABILITY_WAIT_PER_VIEWPORT_MS,
    );
  });

  // The planted control on the other side of the same seam. A ratio read off the
  // window a hold CLIMBED to rather than the one it left applied would still report
  // the tall probe's several windows here, and would go on charging every later
  // capture in the run for a window this one has already given back.
  it("reports one window again once the capture has put the window back", async () => {
    const startedAt = testerWindow();
    const captureWindow = new CaptureWindow(startedAt, new RecordingWindowDriver());
    const surface = mountSurfaceOfHeightPx(TALL_CAPTURE_PROBE_HEIGHT_PX, startedAt);

    await captureWindow.holdWhole(surface, "tall-capture-probe");
    await captureWindow.restore();

    expect(stabilityWaitMsFor(captureWindow.heldViewportRatio)).toBe(
      STABILITY_WAIT_PER_VIEWPORT_MS,
    );
  });
});
