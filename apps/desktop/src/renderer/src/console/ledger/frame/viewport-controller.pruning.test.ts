// What the window cap prunes, and what a prune costs the reader holding the log.
//
// Its own file beside `viewport-controller.test.ts` because the subject is a
// different one: that suite asks where the reading position lands, and these cases
// ask which rows survive a reconcile at all — the veto the scroll controller holds,
// the pin the anchor holds, the prior a pruned row takes with it, and the refusal
// that has to be re-asked rather than remembered. Both drive the same controller
// against the same conditions, which is what `viewport-controller.test-support.ts` is
// for.
//
// The surface is a real detached element and no case asserts a pixel: every geometry
// read under `happy-dom` answers zero, so the claims are about which objects were
// CALLED and with what.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { LEDGER_ROW_HEIGHT_ESTIMATE_PX, LEDGER_WINDOW_ROW_CAP } from "./frame-bounds.js";
import { countingSurface } from "./scroll-surface.test-support.js";
import { LedgerViewportController } from "./viewport-controller.js";
import { CALM, syntheticRows } from "./viewport-controller.test-support.js";

describe("the viewport controller — pruning under a reader", () => {
  /** Far enough back that the cap wants the row, near enough to name in a claim. */
  const READER_ROW_INDEX = 10;
  const READER_ROW_KEY = `row-${String(READER_ROW_INDEX)}`;
  const LOADED_ROW_COUNT = 4400;
  const INITIAL_SCROLL_TOP_PX = 2000;

  /** A surface tall enough that no compensation this case performs is clamped. */
  function tallSurface(initialScrollTop: number): ReturnType<typeof countingSurface> {
    return countingSurface({ initialScrollTop, clientHeight: 300, scrollHeight: 400_000 });
  }

  it("stops the prune at the reader's row and moves the offset by exactly what it took", () => {
    const surface = tallSurface(INITIAL_SCROLL_TOP_PX);
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: -12 });

    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });

    // Contiguous, and all of it above the reader: the ten rows before them, in order.
    expect(controller.snapshot().lastPrune?.prunedKeys).toStrictEqual(
      Array.from({ length: READER_ROW_INDEX }, (_unused, index) => `row-${String(index)}`),
    );
    expect(controller.snapshot().rowKeys[0]).toBe(READER_ROW_KEY);
    // And the reader keeps their pixel, by arithmetic rather than by a virtualizer
    // read that would still answer in the pre-prune index space.
    expect(controller.scroll.writeCount("prune-compensation")).toBe(1);
    expect(surface.scrollTop).toBe(
      INITIAL_SCROLL_TOP_PX - READER_ROW_INDEX * LEDGER_ROW_HEIGHT_ESTIMATE_PX,
    );
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(0);
  });

  it("defers by name when the reader is on the oldest row it could have taken", () => {
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(tallSurface(INITIAL_SCROLL_TOP_PX));
    controller.anchor.capture({ rowKey: "row-0", offsetWithinViewportPx: 0 });

    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });

    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("reading-floor");
    expect(controller.snapshot().rowKeys).toHaveLength(LOADED_ROW_COUNT);
  });

  it("takes the rows it had to leave once the reader returns to the tail", () => {
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(tallSurface(INITIAL_SCROLL_TOP_PX));
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: -12 });
    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });

    controller.jumpToTail();
    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });

    expect(controller.snapshot().rowKeys).toHaveLength(LEDGER_WINDOW_ROW_CAP);
    expect(controller.snapshot().rowKeys[0]).toBe(
      `row-${String(LOADED_ROW_COUNT - LEDGER_WINDOW_ROW_CAP)}`,
    );
  });

  it("negative control: a reader at the tail prunes as it always did, compensating nothing", () => {
    // Without this the floor could have been a cap that never lets go at all.
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(tallSurface(399_700));
    expect(controller.anchor.state.mode).toBe("following");

    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });

    controller.commitPendingTailGlide();
    expect(controller.snapshot().rowKeys).toHaveLength(LEDGER_WINDOW_ROW_CAP);
    expect(controller.scroll.writeCount("prune-compensation")).toBe(0);
    expect(controller.scroll.writeCount("follow-tail")).toBeGreaterThan(0);
  });
});

describe("the viewport controller — a prune the window refused, re-asked", () => {
  const LOADED_ROW_COUNT = 4400;
  const READER_SCROLL_TOP_PX = 2000;
  const VIEWPORT_HEIGHT_PX = 300;
  const CONTENT_HEIGHT_PX = 400_000;
  const TAIL_OFFSET_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;

  /** A reader parked above the tail, on the oldest row the cap wanted to take. */
  function readerAboveTheTail(): {
    controller: LedgerViewportController;
    surface: ReturnType<typeof countingSurface>;
  } {
    const surface = countingSurface({
      initialScrollTop: READER_SCROLL_TOP_PX,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_PX,
    });
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    controller.anchor.capture({ rowKey: "row-0", offsetWithinViewportPx: 0 });
    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });
    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("reading-floor");
    expect(controller.snapshot().rowKeys).toHaveLength(LOADED_ROW_COUNT);
    return { controller, surface };
  }

  it("takes the rows the reading floor held back, with no second reconcile", () => {
    // THE CASE THE ROW SET COULD NOT REPORT. Nothing about the log changes when a
    // reader comes back to the tail, so the reconcile that would have re-asked never
    // arrives on a quiet session — and the window stayed over its cap for as long as
    // nobody typed. `reconcile` is deliberately not called again here.
    const { controller, surface } = readerAboveTheTail();

    surface.moveTo(TAIL_OFFSET_PX);
    expect(controller.anchor.state.mode).toBe("following");
    controller.retryDeferredPrune();

    expect(controller.snapshot().lastPrune?.applied).toBe(true);
    expect(controller.snapshot().rowKeys).toHaveLength(LEDGER_WINDOW_ROW_CAP);
    expect(controller.snapshot().rowKeys[0]).toBe(
      `row-${String(LOADED_ROW_COUNT - LEDGER_WINDOW_ROW_CAP)}`,
    );
  });

  it("takes them when a pin lifts, likewise without one", () => {
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(countingSurface({ clientHeight: VIEWPORT_HEIGHT_PX, scrollHeight: 4000 }));
    controller.anchor.pin("cursor-3");
    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });
    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("pinned-history");

    controller.anchor.unpin();
    controller.retryDeferredPrune();

    expect(controller.snapshot().rowKeys).toHaveLength(LEDGER_WINDOW_ROW_CAP);
  });

  it("takes them when the write that vetoed the prune has finished", () => {
    // The veto is raised and dropped inside ONE synchronous glide, so the only way to
    // reconcile under it is from a subscriber the glide itself wakes — which is
    // exactly how the effect that reconciles reaches it in a tree. Nothing observes
    // the veto lifting, which is why the retry is keyed on the refusal instead.
    const surface = countingSurface({
      initialScrollTop: READER_SCROLL_TOP_PX,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_PX,
    });
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    let reconciledUnderTheVeto = false;
    controller.scroll.subscribeToGeometry(() => {
      if (reconciledUnderTheVeto || !controller.scroll.vetoesPrune()) {
        return;
      }
      reconciledUnderTheVeto = true;
      controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });
    });

    controller.jumpToTail();
    expect(reconciledUnderTheVeto).toBe(true);
    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("scroll-write");
    expect(controller.snapshot().rowKeys).toHaveLength(LOADED_ROW_COUNT);

    controller.retryDeferredPrune();

    expect(controller.snapshot().rowKeys).toHaveLength(LEDGER_WINDOW_ROW_CAP);
  });

  it("negative control: re-asking changes nothing while the reader is still above the tail", () => {
    // Without this the retry could be a cap that ignores the reading floor outright,
    // which is the promise the floor exists to keep.
    const { controller } = readerAboveTheTail();

    controller.retryDeferredPrune();

    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("reading-floor");
    expect(controller.snapshot().rowKeys).toHaveLength(LOADED_ROW_COUNT);
  });

  it("negative control: re-asking after a prune that landed does nothing at all", () => {
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(countingSurface({ clientHeight: VIEWPORT_HEIGHT_PX, scrollHeight: 4000 }));
    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });
    const settled = controller.snapshot();
    expect(settled.lastPrune?.applied).toBe(true);

    controller.retryDeferredPrune();

    // Identity, not length: a retry that re-ran the fold would publish a new snapshot
    // for a window nothing had changed, and every memo below the frame keys on these.
    expect(controller.snapshot()).toBe(settled);
  });
});
