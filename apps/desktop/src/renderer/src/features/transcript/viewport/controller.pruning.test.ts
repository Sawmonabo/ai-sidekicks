// What the window's cuts and admissions cost the reader, driven through the controller with
// `controller.test-support.ts`. No virtualizer is bound, so every row sits at the measurement
// table's estimate and a row's place is that arithmetic; the scroll container is a detached
// element whose offset the chokepoint writes.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { TRANSCRIPT_GESTURE_GAP_MS } from "./caps.js";
import { ViewportController } from "./controller.js";
import { CALM, NO_LINK, attachReaderAt, syntheticRows } from "./controller.test-support.js";

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
    controller.reconcile({ rows, isChangingRow: (rowKey) => rowKey === "row-0" }, NO_LINK);
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: -12 });
    expect(controller.anchor.state.mode).not.toBe("following");
    const readerOffsetBeforeCut = offsetOnScreen(controller, READER_ROW_KEY);

    controller.reconcile({ rows, ...CALM }, NO_LINK);
    // Paid at the commit of the render that drops the rows, by arithmetic on the offset.
    expect(controller.scroll.writeCount("prune-compensation")).toBe(0);
    controller.commitPendingPositionHold(controller.snapshot().rows);

    expect(controller.snapshot().rowKeys[0]).not.toBe("row-0");
    expect(controller.snapshot().lastPrune?.prunedAboveKeys.length).toBeGreaterThan(0);
    expect(offsetOnScreen(controller, READER_ROW_KEY)).toBe(readerOffsetBeforeCut);
    expect(controller.scroll.writeCount("prune-compensation")).toBe(1);

    // The reader scrolls up one row, into the approach band: one stretch arrives above them, and
    // the row then at the top of the viewport stays there once the stretch is laid out.
    const keysBeforeAdmission = controller.snapshot().rowKeys;
    const firstOnScreenKey = keysBeforeAdmission[1] ?? "";
    const firstOnScreenOffset = (controller.rowStartPx(firstOnScreenKey) ?? 0) - rowHeightPx;
    scrollContainer.moveTo(rowHeightPx);
    expect(controller.snapshot().rowKeys.indexOf(keysBeforeAdmission[0] ?? "")).toBeGreaterThan(0);

    controller.commitPendingPositionHold(controller.snapshot().rows);

    expect(offsetOnScreen(controller, firstOnScreenKey)).toBe(firstOnScreenOffset);
  });
});

describe("the viewport controller — one stretch per gesture", () => {
  it("ends a gesture at the box's scrollend and a pause after it, whatever the app clock reads", () => {
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
    controller.reconcile({ rows, ...CALM }, NO_LINK);
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: 0 });
    const firstHeldKey = (): string | undefined => controller.snapshot().rowKeys[0];
    // Each sample lands at a new offset near the top, since a sample that repeats the last is
    // never published.
    const approachTop = (offsetPx: number, inputAtMs: number): void => {
      scrollContainer.moveTo(offsetPx, inputAtMs);
      controller.commitPendingPositionHold(controller.snapshot().rows);
    };

    const headBeforeGesture = firstHeldKey();
    approachTop(3 * rowHeightPx, 1_000);
    const headAfterFirstStretch = firstHeldKey();
    expect(headAfterFirstStretch).not.toBe(headBeforeGesture);

    // The same gesture: a sample one frame later admits nothing more.
    approachTop(2 * rowHeightPx, 1_016);
    expect(firstHeldKey()).toBe(headAfterFirstStretch);

    // A trackpad's momentum wheel a busy machine handed over long late, moving the box slowly:
    // before the box's scrollend it is still the same gesture.
    const lateMomentumAtMs = 1_016 + 400;
    approachTop(2 * rowHeightPx - 1, lateMomentumAtMs);
    expect(firstHeldKey()).toBe(headAfterFirstStretch);

    // The box stops and the platform ends the scroll; a pause as long as the gap after it ends the
    // gesture, so the next approach brings a stretch of its own.
    scrollContainer.endScroll();
    approachTop(rowHeightPx, lateMomentumAtMs + TRANSCRIPT_GESTURE_GAP_MS);
    expect(firstHeldKey()).not.toBe(headAfterFirstStretch);
  });

  it("carries a fling on through a frame a busy machine drew late, and ends it at a pause", () => {
    const rows = syntheticRows(LOG_ROW_COUNT);
    const controller = new ViewportController({ clock: new ManualClock() });
    const rowHeightPx = controller.measurements.heightOf("row-0");
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 200 * rowHeightPx,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: 400_000,
    });
    controller.attach(scrollContainer);
    controller.reconcile({ rows, ...CALM }, NO_LINK);
    controller.anchor.capture({ rowKey: READER_ROW_KEY, offsetWithinViewportPx: 0 });
    const firstHeldKey = (): string | undefined => controller.snapshot().rowKeys[0];
    const scrollTopPx = (): number => controller.scroll.geometry?.scrollTop ?? Number.NaN;
    const commitHold = (): void => {
      controller.commitPendingPositionHold(controller.snapshot().rows);
    };

    // The hand flicks toward the head and lets go; the first stretch arrives.
    scrollContainer.moveTo(3 * rowHeightPx, 1_000);
    commitHold();
    const headAfterFirstStretch = firstHeldKey();
    // A frame on, the momentum moves the box a pixel, the gesture's pace from here. The
    // transcript's own write in that frame fires a scrollend while the fling goes on.
    scrollContainer.coastTo(scrollTopPx() - 1, 1_016);
    commitHold();
    scrollContainer.endScroll();
    // The main thread draws the next frame late, and the box moved on through it faster than that
    // pace: the same gesture, so no stretch more.
    const lateFrameAtMs = 1_016 + TRANSCRIPT_GESTURE_GAP_MS + 33;
    scrollContainer.coastTo(rowHeightPx, lateFrameAtMs);
    commitHold();
    expect(firstHeldKey()).toBe(headAfterFirstStretch);

    // The fling ends, then after a pause with the box still the reader's wheel jumps it half a row,
    // faster than the gesture's pace too: the input after the pause makes it a gesture of its own.
    scrollContainer.endScroll();
    scrollContainer.moveTo(rowHeightPx / 2, lateFrameAtMs + TRANSCRIPT_GESTURE_GAP_MS);
    commitHold();
    expect(firstHeldKey()).not.toBe(headAfterFirstStretch);
  });
});
