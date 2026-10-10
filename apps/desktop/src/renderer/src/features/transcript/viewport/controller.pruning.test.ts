// What the window's cuts and admissions cost the reader, driven through the controller with
// `controller.test-support.ts`. No virtualizer is bound, so every row sits at the measurement
// table's estimate and a row's place is that arithmetic; the scroll container is a detached
// element whose offset the chokepoint writes.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { TRANSCRIPT_GESTURE_GAP_MS } from "./caps.js";
import { ViewportController } from "./controller.js";
import { CALM, attachReaderAt, syntheticRows } from "./controller.test-support.js";

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
    const controller = new ViewportController({ clock: new ManualClock() });
    const scrollContainer = attachReaderAt(controller, {
      offsetPx: 200 * rowHeightPx + 12,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: 400_000,
    });
    // The first row is still changing, so the cut above stops at it: the rows above the reader
    // stay laid out until it settles.
    controller.reconcile({ rows, isChangingRow: (rowKey) => rowKey === "row-0" });
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

    controller.commitPendingPositionHold(rows);

    expect(offsetOnScreen(controller, firstOnScreenKey)).toBe(firstOnScreenOffset);
  });
});

describe("the viewport controller — one stretch per gesture", () => {
  it("tells gestures apart by the scroll events' own time stamps, whatever the app clock reads", () => {
    const rows = syntheticRows(LOG_ROW_COUNT);
    // The app clock never moves, as in a fixture build: only the events' stamps can end a gesture.
    const controller = new ViewportController({ clock: new ManualClock() });
    const rowHeightPx = controller.measurements.heightOf("row-0");
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 200 * rowHeightPx,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: 400_000,
    });
    controller.attach(scrollContainer);
    controller.reconcile({ rows, ...CALM });
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: 0 });
    controller.reconcile({ rows, ...CALM });
    const firstHeldKey = (): string | undefined => controller.snapshot().rowKeys[0];
    // Each sample lands at a new offset near the top, since a sample that repeats the last is
    // never published.
    const approachTop = (offsetPx: number, inputAtMs: number): void => {
      scrollContainer.moveTo(offsetPx, inputAtMs);
      controller.commitPendingPositionHold(rows);
    };

    const headBeforeGesture = firstHeldKey();
    approachTop(3 * rowHeightPx, 1_000);
    const headAfterFirstStretch = firstHeldKey();
    expect(headAfterFirstStretch).not.toBe(headBeforeGesture);

    // The same gesture: a sample one frame later admits nothing more.
    approachTop(2 * rowHeightPx, 1_016);
    expect(firstHeldKey()).toBe(headAfterFirstStretch);

    // A pause as long as the gap ends the gesture, so the next approach brings a stretch of its
    // own.
    approachTop(rowHeightPx, 1_016 + TRANSCRIPT_GESTURE_GAP_MS);
    expect(firstHeldKey()).not.toBe(headAfterFirstStretch);
  });
});
