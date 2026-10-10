// What the head hold a reconcile arms writes when it is committed, and that a press's hold
// outranks it. Runs against a real `ScrollController` over a detached container; the retained key
// list, the row offsets and the rows the reader saw are the steered seam, so the head hold's
// arithmetic is assertable without a virtualizer.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import {
  createCountingScrollContainer,
  type CountingScrollContainer,
} from "#renderer/lib/scroll/container.test-support.js";
import { ViewportDeferredHold } from "./deferred-hold.js";
import { type ReadingAnchorPoint } from "./reading-anchor.js";

const ROW_HEIGHT_PX = 40;

/** The viewport's height: three rows and a bit, so a shift is visible. */
const VIEWPORT_HEIGHT_PX = 3 * ROW_HEIGHT_PX + 10;

interface HoldUnderTest {
  readonly hold: ViewportDeferredHold;
  readonly scroll: ScrollController;
  /** The layout engine's stand-in — `happy-dom` answers zero for every dimension. */
  readonly scrollContainer: CountingScrollContainer;
  setRowKeys: (rowKeys: readonly string[]) => void;
}

function holdUnderTest(holdReadingPosition: () => void = () => undefined): HoldUnderTest {
  const scroll = new ScrollController({ clock: new ManualClock() });
  const scrollContainer = createCountingScrollContainer({ initialScrollTop: 0 });
  scroll.attach(scrollContainer);
  let rowKeys: readonly string[] = [];
  const hold = new ViewportDeferredHold({
    scroll,
    rowKeys: () => rowKeys,
    // A flat row height, so the offset a hold writes is arithmetic a case can state.
    offsetOfIndex: (index) => index * ROW_HEIGHT_PX,
    // The anchored hold's write is the controller's; a case counts the calls it is owed.
    holdReadingPosition,
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

/** The rows a viewport at `scrollTopPx` shows over `rowKeys`, at the flat row height. */
function rowsInViewAt(rowKeys: readonly string[], scrollTopPx: number): ReadingAnchorPoint[] {
  return rowKeys.flatMap((rowKey, index) => {
    const offsetWithinViewportPx = index * ROW_HEIGHT_PX - scrollTopPx;
    return offsetWithinViewportPx > -ROW_HEIGHT_PX && offsetWithinViewportPx < VIEWPORT_HEIGHT_PX
      ? [{ rowKey, offsetWithinViewportPx }]
      : [];
  });
}

/** Where a row stands below the top of the viewport after the hold, at the flat row height. */
function offsetInViewOf(
  subject: HoldUnderTest,
  rowKeys: readonly string[],
  rowKey: string,
): number {
  return rowKeys.indexOf(rowKey) * ROW_HEIGHT_PX - subject.scrollContainer.scrollTop;
}

describe("TranscriptDeferredHold — the head hold", () => {
  it("holds the rows the reader saw even for a reader who was at the tail", () => {
    // A follower's anchor point is never captured, so an arm that read one would leave this
    // reader unheld, and a reader at the tail is the likeliest to press for history.
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c", "d"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      readRowsInView: () => rowsInViewAt(["c", "d"], 20),
      hasRowSetChanged: true,
    });
    subject.hold.commit(true);

    expect(subject.scrollContainer.scrollTop).toBe(2 * ROW_HEIGHT_PX + 20);
  });

  it("writes nothing when every row the reader saw left the window", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      readRowsInView: () => rowsInViewAt(["gone", "too"], 0),
      hasRowSetChanged: true,
    });
    subject.hold.commit(true);

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
  });

  it("holds the row below a header the page joined rows under, not the header", () => {
    // A run's header keeps its key when the run's earlier calls arrive, so they join beneath it;
    // holding the header would leave it still and push every call the reader saw down.
    const subject = holdUnderTest();
    const before = ["header", "c10", "c11", "c12"];
    const after = ["earlier", "header", "c7", "c8", "c9", ...before.slice(1)];
    subject.setRowKeys(after);

    subject.hold.armAfterReconcile({
      headInsertedCount: 1,
      readRowsInView: () => rowsInViewAt(before, 10),
      hasRowSetChanged: true,
    });
    subject.hold.commit(true);

    expect(offsetInViewOf(subject, after, "c10")).toBe(ROW_HEIGHT_PX - 10);
    expect(offsetInViewOf(subject, after, "c11")).toBe(2 * ROW_HEIGHT_PX - 10);
  });

  it("disarms, so a disposed frame owes no position", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b"]);
    subject.hold.armAfterReconcile({
      headInsertedCount: 1,
      readRowsInView: () => rowsInViewAt(["b"], 0),
      hasRowSetChanged: true,
    });

    subject.hold.disarm();
    subject.hold.commit(true);

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
  });
});

describe("TranscriptDeferredHold — three windows, two pages, one row under the reader", () => {
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
    expect(offsetInViewOf(subject, FIRST_WINDOW, "r42")).toBe(0);

    subject.hold.armAfterReconcile({
      headInsertedCount: 3,
      readRowsInView: () => rowsInViewAt(FIRST_WINDOW, subject.scrollContainer.scrollTop),
      hasRowSetChanged: true,
    });
    subject.setRowKeys(AFTER_FIRST_PAGE);
    subject.hold.commit(true);
    expect(offsetInViewOf(subject, AFTER_FIRST_PAGE, "r42")).toBe(0);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      readRowsInView: () => rowsInViewAt(AFTER_FIRST_PAGE, subject.scrollContainer.scrollTop),
      hasRowSetChanged: true,
    });
    subject.setRowKeys(AFTER_SECOND_PAGE);
    subject.hold.commit(true);
    expect(offsetInViewOf(subject, AFTER_SECOND_PAGE, "r42")).toBe(0);
  });
});

describe("TranscriptDeferredHold — a press that brings rows in above the head", () => {
  it("holds the pressed row, not the rows the reader saw", () => {
    // Opening a group whose first row sits above its header lands that row at the head; the
    // press holds its own row, where a head hold would move the reader to the rows in view.
    let anchoredHoldCount = 0;
    const subject = holdUnderTest(() => {
      anchoredHoldCount += 1;
    });
    subject.setRowKeys(["earlier", "header", "a", "b"]);

    subject.hold.armAnchoredHoldAtCommit();
    subject.hold.armAfterReconcile({
      headInsertedCount: 1,
      readRowsInView: () => rowsInViewAt(["header", "a", "b"], 0),
      hasRowSetChanged: true,
    });
    subject.hold.commit(true);

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
    expect(anchoredHoldCount).toBe(1);
  });
});
