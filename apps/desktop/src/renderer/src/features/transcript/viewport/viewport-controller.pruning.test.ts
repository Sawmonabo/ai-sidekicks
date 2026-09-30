// What the window cap prunes and what a prune costs the reader, driven through the controller
// with `viewport-controller.test-support.ts`. The scroll container is a real detached element
// and no case asserts a pixel: geometry reads under `happy-dom` answer zero, so the claims are
// about which objects were called and with what.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../frame/frame-caps.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX } from "./viewport-constants.js";
import { createCountingScrollContainer } from "../scroll/scroll-container.test-support.js";
import { ViewportController } from "./viewport-controller.js";
import {
  CALM,
  attachedController,
  rowsFrom,
  syntheticRows,
} from "./viewport-controller.test-support.js";

describe("the viewport controller — pruning under a reader", () => {
  /** Far enough back that the cap wants the row, near enough to name in a claim. */
  const READER_ROW_INDEX = 10;
  const READER_ROW_KEY = `row-${String(READER_ROW_INDEX)}`;
  const LOADED_ROW_COUNT = 4400;
  const INITIAL_SCROLL_TOP_PX = 2000;

  /** A scroll container tall enough that no compensation this case performs is clamped. */
  function tallScrollContainer(
    initialScrollTop: number,
  ): ReturnType<typeof createCountingScrollContainer> {
    return createCountingScrollContainer({
      initialScrollTop,
      clientHeight: 300,
      scrollHeight: 400_000,
    });
  }

  it("stops the prune at the reader's row and moves the offset by exactly what it took", () => {
    const scrollContainer = tallScrollContainer(INITIAL_SCROLL_TOP_PX);
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: -12 });

    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });

    expect(controller.snapshot().lastPrune?.prunedKeys).toStrictEqual(
      Array.from({ length: READER_ROW_INDEX }, (_unused, index) => `row-${String(index)}`),
    );
    expect(controller.snapshot().rowKeys[0]).toBe(READER_ROW_KEY);
    // The reader keeps their pixel by arithmetic, not by a virtualizer read that would still
    // answer in the pre-prune index space.
    expect(controller.scroll.writeCount("prune-compensation")).toBe(1);
    expect(scrollContainer.scrollTop).toBe(
      INITIAL_SCROLL_TOP_PX - READER_ROW_INDEX * TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX,
    );
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(0);
  });
});

describe("the viewport controller — a prune the window refused, re-asked", () => {
  const LOADED_ROW_COUNT = 4400;
  const READER_SCROLL_TOP_PX = 2000;
  const VIEWPORT_HEIGHT_PX = 300;
  const CONTENT_HEIGHT_PX = 400_000;
  const TAIL_OFFSET_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;

  it("takes the rest after a pass that APPLIED and stopped at the reader's row", () => {
    // The commonest shape: the reader is on row 10, so the pass takes ten rows and stops,
    // applied with no deferral named and thousands of rows still over the cap. Read through the
    // deferral alone, the re-ask never fired.
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: READER_SCROLL_TOP_PX,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: CONTENT_HEIGHT_PX,
    });
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    controller.anchor.capture({ rowKey: "row-10", offsetWithinViewportPx: -12 });
    controller.reconcile({ rows: syntheticRows(LOADED_ROW_COUNT), ...CALM });
    const partial = controller.snapshot().lastPrune;
    expect(partial?.applied).toBe(true);
    expect(partial?.deferredBecause).toBeUndefined();
    expect(partial?.owedBecause).toBe("reading-floor");
    expect(controller.snapshot().rowKeys).toHaveLength(LOADED_ROW_COUNT - 10);

    scrollContainer.moveTo(TAIL_OFFSET_PX);
    expect(controller.anchor.state.mode).toBe("following");
    controller.retryDeferredPrune();

    expect(controller.snapshot().rowKeys).toHaveLength(TRANSCRIPT_WINDOW_ROW_CAP);
    expect(controller.snapshot().lastPrune?.owedBecause).toBeUndefined();
  });
});

describe("the viewport controller — what a prune costs the rest of the frame", () => {
  it("forgets a pruned row's measurement rather than leaving a prior nobody reads", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: syntheticRows(4000), ...CALM });
    const pruned = controller.snapshot().lastPrune?.prunedKeys[0];
    expect(pruned).toBeDefined();
    controller.measurements.acceptedHeight("row-0", 300);
    controller.reconcile({ rows: syntheticRows(4000), ...CALM });
    expect(controller.measurements.measuredRowCount).toBe(0);
  });
});

describe("the viewport controller — a page landing in front of the window", () => {
  it("pins history at the new head, so the cap stops trimming under the reader", () => {
    const { controller } = attachedController();
    controller.reconcile({ rows: rowsFrom(["c", "d"]), ...CALM });

    controller.reconcile({ rows: rowsFrom(["a", "b", "c", "d"]), ...CALM });

    expect(controller.snapshot().reading.pinnedRootCursor).toBe("cursor-a");
  });

  it("keeps the rows the page brought, over the cap, rather than pruning them away", () => {
    // A backward page lands over the row cap by exactly its length and the cap prunes
    // oldest-first, so without the pin this reconcile would take all fifty rows that just arrived
    // and leave the window as it was.
    const { controller } = attachedController();
    const earlier = rowsFrom(Array.from({ length: 50 }, (_unused, index) => `earlier-${index}`));
    controller.reconcile({ rows: syntheticRows(400), ...CALM });

    controller.reconcile({ rows: [...earlier, ...syntheticRows(400)], ...CALM });

    expect(controller.snapshot().lastPrune?.deferredBecause).toBe("pinned-history");
    expect(controller.snapshot().rows).toHaveLength(450);
    expect(controller.snapshot().rowKeys[0]).toBe("earlier-0");
  });

  it("re-supplying a trimmed set pins nothing and keeps pruning", () => {
    // The cap takes rows from the oldest end and the feed hands over the whole projection, so
    // those rows lead the next set. Read as a page landing at the head, that would pin history
    // and stop the cap for the session.
    const { controller } = attachedController();
    const whole = syntheticRows(4000);
    controller.reconcile({ rows: whole, ...CALM });
    expect(controller.snapshot().rows).toHaveLength(400);

    controller.reconcile({ rows: whole, ...CALM });

    expect(controller.snapshot().reading.pinnedRootCursor).toBeUndefined();
    expect(controller.snapshot().rows).toHaveLength(400);
  });

  it("defers the hold to the commit rather than writing in the pre-insert space", () => {
    // The virtualizer has not re-answered offsets when `reconcile` runs in its passive effect; a
    // write here would put the reader where the named row used to be, above every row the page
    // delivered.
    const { controller } = attachedController();
    controller.reconcile({ rows: rowsFrom(["c", "d"]), ...CALM });
    const writesBefore = controller.scroll.writeCount("hold-reading-position");

    controller.reconcile({ rows: rowsFrom(["a", "b", "c", "d"]), ...CALM });
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(writesBefore);

    controller.commitPendingPositionHold();
    expect(controller.scroll.writeCount("hold-reading-position")).toBe(writesBefore + 1);
  });
});
