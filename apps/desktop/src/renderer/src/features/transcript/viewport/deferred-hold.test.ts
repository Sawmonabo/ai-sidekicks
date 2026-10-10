// What the head hold a reconcile arms writes when it is committed. Runs against a real
// `ScrollController` over a detached container; the retained key list and row offsets are the
// steered seam, so the head hold's arithmetic is assertable without a virtualizer.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import {
  createCountingScrollContainer,
  type CountingScrollContainer,
} from "#renderer/lib/scroll/container.test-support.js";
import { ViewportDeferredHold } from "./deferred-hold.js";

const ROW_HEIGHT_PX = 40;

interface HoldUnderTest {
  readonly hold: ViewportDeferredHold;
  readonly scroll: ScrollController;
  /** The layout engine's stand-in — `happy-dom` answers zero for every dimension. */
  readonly scrollContainer: CountingScrollContainer;
  setRowKeys: (rowKeys: readonly string[]) => void;
}

function holdUnderTest(): HoldUnderTest {
  const scroll = new ScrollController({ clock: new ManualClock() });
  const scrollContainer = createCountingScrollContainer({ initialScrollTop: 0 });
  scroll.attach(scrollContainer);
  let rowKeys: readonly string[] = [];
  const hold = new ViewportDeferredHold({
    scroll,
    rowKeys: () => rowKeys,
    // A flat row height, so the offset a hold writes is arithmetic a case can state.
    offsetOfIndex: (index) => index * ROW_HEIGHT_PX,
    // The immediate arm is the controller's; this suite proves the deferred one.
    holdReadingPosition: () => undefined,
  });
  return {
    hold,
    scroll,
    scrollContainer,
    setRowKeys: (next) => {
      rowKeys = next;
    },
  };
}

describe("TranscriptDeferredHold — the head hold", () => {
  it("holds the head row even for a reader who was at the tail", () => {
    // A follower's anchor point is never captured, so an arm that read one would leave this
    // reader unheld, and a reader at the tail is the likeliest to press for history.
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "c",
      previousHeadStartPx: 0,
      scrollTopPx: 80,
      hasRowSetChanged: true,
    });
    subject.hold.commit(true);

    expect(subject.scrollContainer.scrollTop).toBe(2 * ROW_HEIGHT_PX + 80);
  });

  it("writes nothing when the head row left the window", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "gone",
      previousHeadStartPx: 0,
      scrollTopPx: 80,
      hasRowSetChanged: true,
    });
    subject.hold.commit(true);

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
  });

  it("disarms, so a disposed frame owes no position", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b"]);
    subject.hold.armAfterReconcile({
      headInsertedCount: 1,
      previousHeadKey: "b",
      previousHeadStartPx: 0,
      scrollTopPx: 0,
      hasRowSetChanged: true,
    });

    subject.hold.disarm();
    subject.hold.commit(true);

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
  });
});

describe("TranscriptDeferredHold — three windows, two pages, one row under the reader", () => {
  /** Which row the top of the viewport is showing, at this flat row height. */
  function rowAtViewportTop(rowKeys: readonly string[], scrollTopPx: number): string | undefined {
    return rowKeys[Math.floor(scrollTopPx / ROW_HEIGHT_PX)];
  }

  const FIRST_WINDOW = ["r40", "r41", "r42", "r43"];
  const AFTER_FIRST_PAGE = ["r35", "r36", "r37", ...FIRST_WINDOW];
  const AFTER_SECOND_PAGE = ["r30", "r31", ...AFTER_FIRST_PAGE];
  /** Where the reader is standing: two rows down, so a shift is visible. */
  const READING_AT_PX = 2 * ROW_HEIGHT_PX;

  it("leaves the row the reader is on exactly where it was, twice running", () => {
    // Each page lands above the reader and pushes the rows below it down by its own height;
    // without the hold the viewport shows a row three earlier the first time, two more the second.
    const subject = holdUnderTest();
    subject.setRowKeys(FIRST_WINDOW);
    subject.scrollContainer.scrollTop = READING_AT_PX;
    expect(rowAtViewportTop(FIRST_WINDOW, subject.scrollContainer.scrollTop)).toBe("r42");

    subject.hold.armAfterReconcile({
      headInsertedCount: 3,
      previousHeadKey: "r40",
      previousHeadStartPx: 0,
      scrollTopPx: subject.scrollContainer.scrollTop,
      hasRowSetChanged: true,
    });
    subject.setRowKeys(AFTER_FIRST_PAGE);
    subject.hold.commit(true);
    expect(rowAtViewportTop(AFTER_FIRST_PAGE, subject.scrollContainer.scrollTop)).toBe("r42");

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "r35",
      previousHeadStartPx: 0,
      scrollTopPx: subject.scrollContainer.scrollTop,
      hasRowSetChanged: true,
    });
    subject.setRowKeys(AFTER_SECOND_PAGE);
    subject.hold.commit(true);
    expect(rowAtViewportTop(AFTER_SECOND_PAGE, subject.scrollContainer.scrollTop)).toBe("r42");
  });
});
