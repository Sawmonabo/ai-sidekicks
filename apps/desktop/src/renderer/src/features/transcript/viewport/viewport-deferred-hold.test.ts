// Which arm a reconcile owes the reading position, and what each writes. Runs against a real
// `ReadingAnchor` and `ScrollController` over a detached container; the retained key list and row
// offsets are the steered seam, so the head hold's arithmetic is assertable without a
// virtualizer.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { ReadingAnchor } from "../scroll/reading-anchor.js";
import { ScrollController } from "../scroll/scroll-chokepoint.js";
import {
  createCountingScrollContainer,
  type CountingScrollContainer,
} from "../scroll/scroll-container.test-support.js";
import { ViewportDeferredHold } from "./viewport-deferred-hold.js";

const ROW_HEIGHT_PX = 40;

interface HoldUnderTest {
  readonly hold: ViewportDeferredHold;
  readonly anchor: ReadingAnchor;
  readonly scroll: ScrollController;
  /** The layout engine's stand-in — `happy-dom` answers zero for every dimension. */
  readonly scrollContainer: CountingScrollContainer;
  readonly immediateHolds: () => number;
  setRowKeys: (rowKeys: readonly string[]) => void;
}

function holdUnderTest(): HoldUnderTest {
  const anchor = new ReadingAnchor();
  const scroll = new ScrollController({ clock: new ManualClock() });
  const scrollContainer = createCountingScrollContainer({ initialScrollTop: 0 });
  scroll.attach(scrollContainer);
  let rowKeys: readonly string[] = [];
  let immediateHolds = 0;
  const hold = new ViewportDeferredHold({
    anchor,
    scroll,
    rowKeys: () => rowKeys,
    // A flat row height, so the offset a hold writes is arithmetic a case can state.
    offsetOfIndex: (index) => index * ROW_HEIGHT_PX,
    holdReadingPosition: () => {
      immediateHolds += 1;
    },
  });
  return {
    hold,
    anchor,
    scroll,
    scrollContainer,
    immediateHolds: () => immediateHolds,
    setRowKeys: (next) => {
      rowKeys = next;
    },
  };
}

/** Take the reader off the tail, which is what makes the anchored arm reachable. */
function scrollAwayFromTail(anchor: ReadingAnchor): void {
  anchor.observeGeometry({
    scrollTop: 200,
    viewportHeight: 100,
    contentHeight: 4000,
    distanceFromTailPx: 3700,
    isAtTail: false,
    sampledAt: 0,
    cause: "scroll",
  });
}

describe("TranscriptDeferredHold — which arm a reconcile arms", () => {
  it("defers the tail glide while following, and performs it on commit", () => {
    const subject = holdUnderTest();

    subject.hold.armAfterReconcile({ headInsertedCount: 0, previousHeadKey: "a", scrollTopPx: 0 });
    expect(subject.scroll.writeCount("follow-tail")).toBe(0);

    subject.hold.commit();
    expect(subject.scroll.writeCount("follow-tail")).toBe(1);
  });

  it("drops a deferred tail glide the reader scrolled away from", () => {
    const subject = holdUnderTest();
    subject.hold.armAfterReconcile({ headInsertedCount: 0, previousHeadKey: "a", scrollTopPx: 0 });
    scrollAwayFromTail(subject.anchor);

    subject.hold.commit();

    expect(subject.scroll.writeCount("follow-tail")).toBe(0);
  });

  it("holds the head row even for a reader who was at the tail", () => {
    // A follower's anchor point is never captured, so an arm that read one would leave this
    // reader unheld, and a reader at the tail is the likeliest to press for history.
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "c",
      scrollTopPx: 80,
    });
    subject.hold.commit();

    expect(subject.scrollContainer.scrollTop).toBe(2 * ROW_HEIGHT_PX + 80);
    expect(subject.scroll.writeCount("follow-tail")).toBe(0);
  });

  it("writes nothing when the head row left the window", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "gone",
      scrollTopPx: 80,
    });
    subject.hold.commit();

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
  });

  it("disarms both arms, so a disposed frame owes no position", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b"]);
    subject.hold.armAfterReconcile({ headInsertedCount: 1, previousHeadKey: "b", scrollTopPx: 0 });

    subject.hold.disarm();
    subject.hold.commit();

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
    scrollAwayFromTail(subject.anchor);
    subject.setRowKeys(FIRST_WINDOW);
    subject.scrollContainer.scrollTop = READING_AT_PX;
    expect(rowAtViewportTop(FIRST_WINDOW, subject.scrollContainer.scrollTop)).toBe("r42");

    subject.hold.armAfterReconcile({
      headInsertedCount: 3,
      previousHeadKey: "r40",
      scrollTopPx: subject.scrollContainer.scrollTop,
    });
    subject.setRowKeys(AFTER_FIRST_PAGE);
    subject.hold.commit();
    expect(rowAtViewportTop(AFTER_FIRST_PAGE, subject.scrollContainer.scrollTop)).toBe("r42");

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "r35",
      scrollTopPx: subject.scrollContainer.scrollTop,
    });
    subject.setRowKeys(AFTER_SECOND_PAGE);
    subject.hold.commit();
    expect(rowAtViewportTop(AFTER_SECOND_PAGE, subject.scrollContainer.scrollTop)).toBe("r42");
  });
});
