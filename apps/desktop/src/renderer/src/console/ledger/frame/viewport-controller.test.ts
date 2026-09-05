// The wiring, driven end to end: rows in, and the reader held in place.
//
// The surface is a real detached element. Every geometry read under `happy-dom`
// answers zero, which is exactly why nothing here asserts a pixel: the claims are
// about which objects were CALLED and with what — that holding a reading position is
// one glide named for its caller, and that a scroll costs no reconcile. Where a pixel
// is the claim, the case lives in `scroll-chokepoint.test.ts` or
// `row-measurement-ledger.test.ts`, which drive their subjects without a DOM.
//
// What the CAP prunes is `viewport-controller.pruning.test.ts`', which reconciles the
// same controller against the same conditions through `viewport-controller.test-support.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { countingSurface } from "./scroll-surface.test-support.js";
import { LedgerViewportController } from "./viewport-controller.js";
import { CALM, syntheticRows } from "./viewport-controller.test-support.js";

function attachedController(): { controller: LedgerViewportController; clock: ManualClock } {
  const clock = new ManualClock();
  const controller = new LedgerViewportController({ clock });
  controller.attach(document.createElement("div"));
  return { controller, clock };
}

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
    // `useSyncExternalStore` tears the tree if the getter returns a fresh object
    // per call, so this is a contract rather than an optimisation.
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(4), ...CALM });
    expect(controller.snapshot()).toBe(controller.snapshot());
  });

  it("carries the scroll controller's veto and the anchor's pin into prune", () => {
    const { controller } = attachedController();
    controller.anchor.pin("cursor-3");
    controller.reconcile({ rows: syntheticRows(4000), ...CALM });
    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("pinned-history");
    controller.anchor.unpin();
    controller.reconcile({ rows: syntheticRows(4000), ...CALM });
    expect(controller.snapshot().lastPrune?.applied).toBe(true);
  });

  it("forgets a pruned row's measurement rather than leaving a prior nobody reads", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(4000), ...CALM });
    const pruned = controller.snapshot().lastPrune?.prunedKeys[0];
    expect(pruned).toBeDefined();
    controller.measurements.acceptedHeight("row-0", 300);
    controller.reconcile({ rows: syntheticRows(4000), ...CALM });
    expect(controller.measurements.measuredRowCount).toBe(0);
  });

  it("counts rows appended after the reader left the tail", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(4), ...CALM });
    controller.anchor.observeGeometry({
      scrollTop: 20,
      viewportHeight: 100,
      contentHeight: 4000,
      distanceFromTailPx: 3880,
      isAtTail: false,
      sampledAt: 0,
      cause: "scroll",
    });
    controller.reconcile({ rows: syntheticRows(7), ...CALM });
    expect(controller.snapshot().reading).toMatchObject({
      mode: "reading-with-new-rows",
      newRowCount: 3,
    });
  });

  it("negative control: while following, an append counts as nothing to jump to", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(4), ...CALM });
    controller.reconcile({ rows: syntheticRows(7), ...CALM });
    expect(controller.snapshot().reading.newRowCount).toBe(0);
  });
});

describe("the viewport controller — holding the reading position", () => {
  it("follows the tail while following, and holds the anchor while reading", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    // The tail glide is ARMED by the reconcile and performed once the new height is
    // committed — see the group below for why, and for the case that pins it.
    controller.commitPendingTailGlide();
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
    // Guessing at a replacement is how a ledger teleports.
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
  it("notifies nothing for a scroll that changes only where the reader is", () => {
    // The budget claim, driven rather than asserted: a snapshot that carried the
    // anchor point or the raw geometry would notify React on every pixel, which is
    // exactly the render `directDomUpdates` exists to avoid — and, because a render
    // re-runs the virtualizer's layout effects, one turn of a loop that would not
    // settle.
    const surface = countingSurface();
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.reconcile({ rows: syntheticRows(40), ...CALM });
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    for (let tick = 0; tick < 20; tick += 1) {
      surface.moveTo(40 + tick * 17);
    }
    expect(notifications).toBe(0);
    expect(controller.anchor.state.anchorPoint).toBeDefined();
  });

  it("negative control: a scroll that changes a RENDERED fact does notify", () => {
    const surface = countingSurface();
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.reconcile({ rows: syntheticRows(40), ...CALM });
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    // Reaching the tail is a mode change, and the mode is on screen.
    surface.moveTo(surface.scrollHeight - surface.clientHeight);
    expect(notifications).toBeGreaterThan(0);
    expect(controller.snapshot().reading.mode).toBe("following");
  });

  it("does not re-anchor to a position the ledger itself just wrote", () => {
    // Anchoring to the result of a glide discards the position the glide was
    // performed to preserve.
    const surface = countingSurface();
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.reconcile({ rows: syntheticRows(40), ...CALM });
    surface.moveTo(220);
    const capturedByTheReader = controller.anchor.state.anchorPoint;
    expect(capturedByTheReader).toBeDefined();
    controller.scroll.glideTo("deep-link", 900);
    expect(controller.anchor.state.anchorPoint).toBe(capturedByTheReader);
  });
});

describe("the viewport controller — a pane that changed size", () => {
  /** A viewport parked at the bottom of its content, in the tail's own arithmetic. */
  function surfaceAtTail(): ReturnType<typeof countingSurface> {
    return countingSurface({ initialScrollTop: 3700, clientHeight: 300, scrollHeight: 4000 });
  }

  it("keeps a follower following, and re-glides to the tail the resize moved", () => {
    // A shorter viewport raises the distance from the tail on its own. Without the
    // asymmetry the anchor states, this alone would stop the ledger following.
    const surface = surfaceAtTail();
    const clock = new ManualClock();
    const controller = new LedgerViewportController({ clock });
    controller.attach(surface);
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    const followsBefore = controller.scroll.writeCount("follow-tail");

    surface.resizeTo(150, 4000);
    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(controller.anchor.state.mode).toBe("following");
    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBefore + 1);
    expect(surface.scrollTop).toBe(3850);
  });

  it("negative control: a reader who had scrolled away is not dragged to the tail", () => {
    const surface = countingSurface({
      initialScrollTop: 500,
      clientHeight: 300,
      scrollHeight: 4000,
    });
    const clock = new ManualClock();
    const controller = new LedgerViewportController({ clock });
    controller.attach(surface);
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -8 });

    surface.resizeTo(150, 4000);
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
   * A follower at the tail, with rows already reconciled.
   *
   * `resizeTo` here stands for the SIZER growing rather than the pane changing size:
   * the virtualizer writes the container's height directly under `directDomUpdates`,
   * and what the chokepoint sees of that write is a taller `scrollHeight` under an
   * unchanged `clientHeight`.
   */
  function followerAtTail(): {
    controller: LedgerViewportController;
    surface: ReturnType<typeof countingSurface>;
  } {
    const surface = countingSurface({
      initialScrollTop: TAIL_BEFORE_PX,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_BEFORE_PX,
    });
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.reconcile({ rows: syntheticRows(20), ...CALM });
    controller.commitPendingTailGlide();
    expect(controller.anchor.state.mode).toBe("following");
    return { controller, surface };
  }

  it("lands on the tail the appended rows produced, not the one they replaced", () => {
    const { controller, surface } = followerAtTail();
    const followsBeforeAppend = controller.scroll.writeCount("follow-tail");

    controller.reconcile({ rows: syntheticRows(24), ...CALM });
    // NO GLIDE HAS BEEN PERFORMED YET, and that is the fix: React has not rendered
    // the four new rows, so the sizer still carries the old total size and a glide
    // here would scroll to the bottom of the log as it was BEFORE the append. This is
    // the reading that fails against the pre-commit glide.
    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBeforeAppend);
    expect(surface.scrollTop).toBe(TAIL_BEFORE_PX);

    surface.resizeTo(VIEWPORT_HEIGHT_PX, CONTENT_HEIGHT_AFTER_PX);
    controller.commitPendingTailGlide();

    expect(surface.scrollTop).toBe(TAIL_AFTER_PX);
    // The negative control rides the same two readings: the offset the pre-commit
    // glide would have chosen is a different number, and it is the one the reader was
    // left at before this fix.
    expect(TAIL_BEFORE_PX).not.toBe(TAIL_AFTER_PX);
  });

  it("performs one glide per append, not one per render", () => {
    // The binding calls the commit after every render, so a commit that re-glided on
    // an unarmed pass would write the offset on every frame a streaming lane causes.
    const { controller } = followerAtTail();
    controller.reconcile({ rows: syntheticRows(24), ...CALM });
    const followsBeforeCommit = controller.scroll.writeCount("follow-tail");

    controller.commitPendingTailGlide();
    controller.commitPendingTailGlide();
    controller.commitPendingTailGlide();

    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBeforeCommit + 1);
  });

  it("negative control: a reader who left the tail before the commit is not dragged to it", () => {
    // The arming says what was true at the reconcile; the commit runs a render later,
    // and a reader who scrolled in between is no longer following. Without the
    // re-check the deferral would reintroduce exactly the teleport the anchor exists
    // to prevent.
    const { controller, surface } = followerAtTail();
    controller.reconcile({ rows: syntheticRows(24), ...CALM });
    const followsBeforeCommit = controller.scroll.writeCount("follow-tail");

    surface.moveTo(500);
    expect(controller.anchor.state.mode).not.toBe("following");
    surface.resizeTo(VIEWPORT_HEIGHT_PX, CONTENT_HEIGHT_AFTER_PX);
    controller.commitPendingTailGlide();

    expect(controller.scroll.writeCount("follow-tail")).toBe(followsBeforeCommit);
    expect(surface.scrollTop).toBe(500);
  });

  it("holds a reader's anchor during the reconcile itself, deferring nothing", () => {
    // Only the following arm is deferred: the anchor arm's index lookup is measured
    // in the pre-render offset space on purpose, so moving it would break it.
    const surface = countingSurface({
      initialScrollTop: 500,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_BEFORE_PX,
    });
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.anchor.capture({ rowKey: "row-5", offsetWithinViewportPx: -8 });

    controller.reconcile({ rows: syntheticRows(20), ...CALM });

    expect(controller.scroll.writeCount("hold-reading-position")).toBe(1);
    expect(controller.scroll.writeCount("follow-tail")).toBe(0);
  });
});

describe("the viewport controller — teardown", () => {
  it("disposes terminally, and arms nothing afterwards", () => {
    const { controller, clock } = attachedController();
    controller.schedulePublish();
    expect(clock.pendingCount).toBe(1);
    controller.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
    controller.schedulePublish();
    expect(clock.pendingCount).toBe(0);
  });
});
