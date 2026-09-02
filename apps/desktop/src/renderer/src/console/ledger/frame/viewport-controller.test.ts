// The wiring, driven end to end: rows in, prune, and the reader held in place.
//
// The surface is a real detached element. Every geometry read under `happy-dom`
// answers zero, which is exactly why nothing here asserts a pixel: the claims are
// about which objects were CALLED and with what — that the prune conditions carry
// the scroll controller's veto and the anchor's pin, that a pruned row's prior is
// forgotten with it, and that holding a reading position is one glide named for its
// caller. Where a pixel is the claim, the case lives in `scroll-chokepoint.test.ts`
// or `row-measurement-ledger.test.ts`, which drive their subjects without a DOM.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { countingSurface } from "./scroll-surface-fixture.js";
import { LedgerViewportController } from "./viewport-controller.js";
import type { LedgerViewportRow } from "./viewport-controller.js";

/**
 * A surface whose scroll listeners can be counted, at fixed geometry.
 *
 * Structural rather than an element because `happy-dom` answers zero for every
 * geometry read, and a rect of zeroes would make the replay assertions vacuous.
 */

function syntheticRows(count: number, chapterKey?: string): readonly LedgerViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `${chapterKey ?? "row"}-${String(index)}`,
    parentKey: chapterKey,
    rootCursor: `cursor-${String(index)}`,
  }));
}

function attachedController(): { controller: LedgerViewportController; clock: ManualClock } {
  const clock = new ManualClock();
  const controller = new LedgerViewportController({ clock });
  controller.attach(document.createElement("div"));
  return { controller, clock };
}

const CALM: { hasActiveTurn: boolean; isRevealDraining: boolean } = {
  hasActiveTurn: false,
  isRevealDraining: false,
};

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
    expect(controller.scroll.writeCount("follow-tail")).toBeGreaterThan(0);

    controller.anchor.observeGeometry({
      scrollTop: 400,
      viewportHeight: 100,
      contentHeight: 4000,
      distanceFromTailPx: 3500,
      isAtTail: false,
      sampledAt: 0,
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
