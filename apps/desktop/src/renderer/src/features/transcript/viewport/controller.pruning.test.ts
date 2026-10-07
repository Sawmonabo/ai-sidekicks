// What the window's cuts and admissions cost the reader, driven through the controller with
// `controller.test-support.ts`. No virtualizer is bound, so every row sits at the measurement
// table's estimate and a row's place is that arithmetic; the scroll container is a detached
// element whose offset the chokepoint writes.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { ViewportController } from "./controller.js";
import { CALM, syntheticRows } from "./controller.test-support.js";

/** A log long enough that the window lets go of most of it around a reader in the middle. */
const LOG_ROW_COUNT = 400;
const READER_ROW_KEY = "row-200";
const VIEWPORT_HEIGHT_PX = 300;

/** Where a row's top edge sits relative to the top of the viewport. */
function offsetOnScreen(controller: ViewportController, rowKey: string): number | undefined {
  const rowStartPx = controller.rowStartPx(rowKey);
  const scrollTopPx = controller.scroll.geometry?.scrollTop;
  return rowStartPx === undefined || scrollTopPx === undefined
    ? undefined
    : rowStartPx - scrollTopPx;
}

describe("the viewport controller — the row under the reader stays put", () => {
  it("keeps the reader's row where it was after a cut above and a stretch admitted above", () => {
    const rows = syntheticRows(LOG_ROW_COUNT);
    const rowHeightPx = new ViewportController({ clock: new ManualClock() }).measurements.heightOf(
      "row-0",
    );
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 200 * rowHeightPx + 12,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: 400_000,
    });
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    // A turn in flight: the window holds the whole log, laid out, the rows above the reader
    // among it.
    controller.reconcile({ rows, hasActiveTurn: true, isRevealDraining: false });
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: -12 });
    expect(controller.anchor.state.mode).not.toBe("following");
    const readerOffsetBeforeCut = offsetOnScreen(controller, READER_ROW_KEY);

    controller.reconcile({ rows, ...CALM });

    expect(controller.snapshot().rowKeys[0]).not.toBe("row-0");
    expect(controller.snapshot().lastPrune?.prunedAboveKeys.length).toBeGreaterThan(0);
    expect(offsetOnScreen(controller, READER_ROW_KEY)).toBe(readerOffsetBeforeCut);
    // Paid by arithmetic: in the mounted frame the virtualizer answers in pre-cut offsets until
    // React re-renders, so an anchor glide in its place would land on the wrong row.
    expect(controller.scroll.writeCount("prune-compensation")).toBe(1);

    // The reader scrolls up one row, into the approach band: one stretch arrives above them, and
    // the row then at the top of the viewport stays there once the stretch is laid out.
    const keysBeforeAdmission = controller.snapshot().rowKeys;
    const firstOnScreenKey = keysBeforeAdmission[1] ?? "";
    const firstOnScreenOffset = (controller.rowStartPx(firstOnScreenKey) ?? 0) - rowHeightPx;
    scrollContainer.moveTo(rowHeightPx);
    expect(controller.snapshot().rowKeys.indexOf(keysBeforeAdmission[0] ?? "")).toBeGreaterThan(0);

    controller.commitPendingPositionHold();

    expect(offsetOnScreen(controller, firstOnScreenKey)).toBe(firstOnScreenOffset);
  });
});
