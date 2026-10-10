// The wiring driven end to end: rows in, and the reader held in place. The scroll container is a
// real detached element and `happy-dom` geometry reads answer zero, so no case asserts a pixel;
// the claims are about which objects were called and with what. Pixel claims live in
// `chokepoint.test.ts` and `row-measurement-table.test.ts`; what the cap prunes is
// `controller.pruning.test.ts`'s; a follower's position, which the virtualizer keeps, and the
// keyboard's jumps are `hooks/useTranscriptViewport.position.test.ts`'s.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { installFakeResizeObserver } from "#test/helpers/element/resize.js";
import { ViewportController } from "./controller.js";
import {
  CALM,
  attachReaderAt,
  attachedController,
  syntheticRows,
} from "./controller.test-support.js";

/** A controller over a box whose reader starts well above the tail, so they read. */
function readingController(): ViewportController {
  const controller = new ViewportController({ clock: new ManualClock() });
  attachReaderAt(controller, { offsetPx: 400, clientHeight: 100, scrollHeight: 4000 });
  return controller;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the viewport controller — reconcile", () => {
  it("takes rows, and publishes one snapshot per reconcile", () => {
    const { controller } = attachedController();
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    const rows = syntheticRows(12);
    controller.reconcile({ rows, ...CALM });
    expect(controller.snapshot().rows).toHaveLength(12);
    expect(controller.snapshot().rowKeys[0]).toBe("row-0");
    expect(notifications).toBeGreaterThanOrEqual(1);
  });

  it("hands back the same snapshot reference until something changes", () => {
    // `useSyncExternalStore` tears the tree if the getter returns a fresh object per call.
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(4), ...CALM });
    expect(controller.snapshot()).toBe(controller.snapshot());
  });
});

describe("the viewport controller — holding the reading position", () => {
  it("holds the anchored row while reading", () => {
    const controller = readingController();
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    expect(controller.anchor.state.mode).toBe("reading");

    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -12 });
    controller.holdReadingPosition();
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);
  });

  it("leaves the offset alone when the anchored row has left the window", () => {
    // Guessing at a replacement is how a transcript teleports.
    const controller = readingController();
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    expect(controller.anchor.state.mode).toBe("reading");

    controller.anchor.capture({ rowKey: "row-not-here", offsetWithinViewportPx: 0 });
    controller.holdReadingPosition();
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(0);
  });
});

describe("the viewport controller — a link to a message the history lacks", () => {
  it("leaves the page where it is once history runs out without the message", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    controller.noteMessageReadBack("reading-back");
    expect(controller.anchor.state.mode).not.toBe("following");

    controller.noteMessageReadBack("not-in-history");

    expect(controller.scroll.writeCount("jump-to-tail")).toBe(0);
    expect(controller.anchor.state.mode).not.toBe("following");
  });
});

describe("the viewport controller — what a scroll does NOT cost", () => {
  it("does not re-anchor to a position the transcript itself just wrote", () => {
    // Anchoring to a glide's result discards the position the glide was performed to preserve.
    const scrollContainer = createCountingScrollContainer();
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    controller.reconcile({ rows: syntheticRows(40), ...CALM });
    scrollContainer.moveTo(220);
    const capturedByTheReader = controller.anchor.state.anchorPoint;
    expect(capturedByTheReader).toBeDefined();
    controller.scroll.glideTo("find-match", 900);
    expect(controller.anchor.state.anchorPoint).toBe(capturedByTheReader);
  });
});

describe("the viewport controller — a pane that changed size", () => {
  it("a reader who had scrolled away is not dragged to the tail", () => {
    const resizeObserver = installFakeResizeObserver();
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    const scrollContainer = attachReaderAt(controller, {
      offsetPx: 500,
      clientHeight: 300,
      scrollHeight: 4000,
    });
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -8 });

    scrollContainer.resizeTo(150, 4000);
    resizeObserver.deliverFor(scrollContainer, 150);
    clock.runFrame();

    expect(controller.anchor.state.mode).toBe("reading");
    expect(controller.scroll.writeCount("follow-tail")).toBe(0);
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);
  });
});

describe("the viewport controller — where a reconcile holds a reader", () => {
  const VIEWPORT_HEIGHT_PX = 300;
  const CONTENT_HEIGHT_PX = 4000;

  it("holds a reader's anchor at the commit of new rows, and during a reconcile of the same", () => {
    // A row joining above the anchor moves its index, which means something only once the
    // virtualizer counts the new rows; with the rows unchanged the index is the one laid out.
    const controller = new ViewportController({ clock: new ManualClock() });
    attachReaderAt(controller, {
      offsetPx: 500,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_PX,
    });
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -8 });
    const rows = syntheticRows(20);

    controller.reconcile({ rows, ...CALM });
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(0);
    controller.commitPendingPositionHold(rows);
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);

    controller.reconcile({ rows, ...CALM });
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(2);
    expect(controller.scroll.writeCount("follow-tail")).toBe(0);
  });
});

describe("the viewport controller — teardown", () => {
  it("disposes terminally, and arms nothing afterwards", () => {
    const { controller, clock } = attachedController();
    // An attach owes an overflow pass of its own (`chokepoint.ts` `attach`) and the drawn band
    // its first widening step, so dispose has a frame and a task to clear.
    expect(clock.pendingCount).toBe(2);
    controller.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });
});
