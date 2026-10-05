// The wiring driven end to end: rows in, and the reader held in place. The scroll container is a
// real detached element and `happy-dom` geometry reads answer zero, so no case asserts a pixel;
// the claims are about which objects were called and with what. Pixel claims live in
// `chokepoint.test.ts` and `row-measurement-table.test.ts`; what the cap prunes is
// `viewport-controller.pruning.test.ts`'s.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/scroll-container.test-support.js";
import { ViewportController } from "./viewport-controller.js";
import { CALM, attachedController, syntheticRows } from "./viewport-controller.test-support.js";

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
  it("follows the tail while following, and holds the anchor while reading", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    // The tail glide is armed by the reconcile and performed once the new height is committed.
    controller.commitPendingPositionHold();
    expect(controller.scroll.writeCount("follow-tail")).toBeGreaterThan(0);

    controller.anchor.observeGeometry({
      scrollTop: 400,
      viewportHeight: 100,
      contentHeight: 4000,
      distanceFromTailPx: 3500,
      isAtTail: false,
      sampledAt: 0,
      cause: "scroll",
    });
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -12 });
    const followsBefore = controller.scroll.writeCount("follow-tail");
    controller.holdReadingPosition();
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);
    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBefore);
  });

  it("leaves the offset alone when the anchored row has left the window", () => {
    // Guessing at a replacement is how a transcript teleports.
    const { controller } = attachedController();
    controller.anchor.observeGeometry({
      scrollTop: 400,
      viewportHeight: 100,
      contentHeight: 4000,
      distanceFromTailPx: 3500,
      isAtTail: false,
      sampledAt: 0,
      cause: "scroll",
    });
    controller.anchor.capture({ rowKey: "row-not-here", offsetWithinViewportPx: 0 });
    controller.holdReadingPosition();
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(0);
  });

  it("jumps to the tail and resumes following in one act", () => {
    const { controller } = attachedController();
    controller.anchor.observeGeometry({
      scrollTop: 400,
      viewportHeight: 100,
      contentHeight: 4000,
      distanceFromTailPx: 3500,
      isAtTail: false,
      sampledAt: 0,
      cause: "scroll",
    });
    controller.jumpToTail();
    expect(controller.snapshot().reading.mode).toBe("following");
    expect(controller.scroll.writeCount("jump-to-tail")).toBe(1);
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
  /** A viewport parked at the bottom of its content, in the tail's own arithmetic. */
  function scrollContainerAtTail(): ReturnType<typeof createCountingScrollContainer> {
    return createCountingScrollContainer({
      initialScrollTop: 3700,
      clientHeight: 300,
      scrollHeight: 4000,
    });
  }

  it("keeps a follower following, and re-glides to the tail the resize moved", () => {
    // A shorter viewport raises the distance from the tail on its own. Without the
    // asymmetry the anchor states, this alone would stop the transcript following.
    const scrollContainer = scrollContainerAtTail();
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    const followsBefore = controller.scroll.writeCount("follow-tail");

    scrollContainer.resizeTo(150, 4000);
    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(controller.anchor.state.mode).toBe("following");
    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBefore + 1);
    expect(scrollContainer.scrollTop).toBe(3850);
  });

  it("a reader who had scrolled away is not dragged to the tail", () => {
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 500,
      clientHeight: 300,
      scrollHeight: 4000,
    });
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -8 });

    scrollContainer.resizeTo(150, 4000);
    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(controller.anchor.state.mode).toBe("reading");
    expect(controller.scroll.writeCount("follow-tail")).toBe(0);
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);
  });
});

describe("the viewport controller — the tail glide and the height it lands against", () => {
  /** A viewport parked at the bottom of its content, in the tail's own arithmetic. */
  const VIEWPORT_HEIGHT_PX = 300;
  const CONTENT_HEIGHT_BEFORE_PX = 4000;
  const CONTENT_HEIGHT_AFTER_PX = 5000;
  const TAIL_BEFORE_PX = CONTENT_HEIGHT_BEFORE_PX - VIEWPORT_HEIGHT_PX;
  const TAIL_AFTER_PX = CONTENT_HEIGHT_AFTER_PX - VIEWPORT_HEIGHT_PX;

  /**
   * A follower at the tail, with rows already reconciled. `resizeTo` stands for the sizer
   * growing, not the pane resizing: the virtualizer writes the container height directly under
   * `directDomUpdates`, so the chokepoint sees a taller `scrollHeight` under an unchanged
   * `clientHeight`.
   */
  function followerAtTail(): {
    controller: ViewportController;
    scrollContainer: ReturnType<typeof createCountingScrollContainer>;
  } {
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: TAIL_BEFORE_PX,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_BEFORE_PX,
    });
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    controller.commitPendingPositionHold();
    expect(controller.anchor.state.mode).toBe("following");
    return { controller, scrollContainer };
  }

  it("lands on the tail the appended rows produced, not the one they replaced", () => {
    const { controller, scrollContainer } = followerAtTail();
    const followsBeforeAppend = controller.scroll.writeCount("follow-tail");

    controller.reconcile({ rows: syntheticRows(24), ...CALM });
    // No glide has been performed yet: React has not rendered the four new rows, so the sizer
    // still has the old total size and a glide now would scroll to the old bottom.
    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBeforeAppend);
    expect(scrollContainer.scrollTop).toBe(TAIL_BEFORE_PX);

    scrollContainer.resizeTo(VIEWPORT_HEIGHT_PX, CONTENT_HEIGHT_AFTER_PX);
    controller.commitPendingPositionHold();

    expect(scrollContainer.scrollTop).toBe(TAIL_AFTER_PX);
    // The offset the pre-commit glide would have chosen is a different number.
    expect(TAIL_BEFORE_PX).not.toBe(TAIL_AFTER_PX);
  });

  it("a reader who left the tail before the commit is not dragged to it", () => {
    // The arming says what was true at the reconcile and the commit runs a render later; a reader
    // who scrolled in between is no longer following, and without the re-check the deferral would
    // teleport them.
    const { controller, scrollContainer } = followerAtTail();
    controller.reconcile({ rows: syntheticRows(24), ...CALM });
    const followsBeforeCommit = controller.scroll.writeCount("follow-tail");

    scrollContainer.moveTo(500);
    expect(controller.anchor.state.mode).not.toBe("following");
    scrollContainer.resizeTo(VIEWPORT_HEIGHT_PX, CONTENT_HEIGHT_AFTER_PX);
    controller.commitPendingPositionHold();

    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBeforeCommit);
    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("holds a reader's anchor during the reconcile itself, deferring nothing", () => {
    // Only the following arm is deferred: the anchor arm's index lookup is measured in the
    // pre-render offset space on purpose.
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 500,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_BEFORE_PX,
    });
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -8 });

    controller.reconcile({ rows: syntheticRows(20), ...CALM });

    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);
    expect(controller.scroll.writeCount("follow-tail")).toBe(0);
  });
});

describe("the viewport controller — teardown", () => {
  it("disposes terminally, and arms nothing afterwards", () => {
    const { controller, clock } = attachedController();
    // An attach owes an overflow pass of its own (`chokepoint.ts` `attach`), so
    // dispose has an armed frame to clear.
    expect(clock.pendingCount).toBe(1);
    controller.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });
});
