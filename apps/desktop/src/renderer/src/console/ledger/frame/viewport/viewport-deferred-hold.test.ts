// Which arm a reconcile owes the reading position, and what each one writes.
//
// Driven against a REAL `ReadingAnchor` and a REAL `LedgerScrollController` over a
// detached surface, so the arbitration is asserted through the objects that arbitrate.
// The two collaborators the controller supplies as functions — the retained key list
// and a row's offset — are the seam this suite steers, which is what makes the head
// hold's arithmetic assertable without a virtualizer.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { ReadingAnchor } from "../measurement/index.js";
import { LedgerScrollController } from "../scroll/index.js";
import { countingSurface, type CountingSurface } from "../scroll/scroll-surface.test-support.js";
import { LedgerDeferredHold } from "./viewport-deferred-hold.js";

const ROW_HEIGHT_PX = 40;

interface HoldUnderTest {
  readonly hold: LedgerDeferredHold;
  readonly anchor: ReadingAnchor;
  readonly scroll: LedgerScrollController;
  /** The layout engine's stand-in — `happy-dom` answers zero for every dimension. */
  readonly surface: CountingSurface;
  readonly immediateHolds: () => number;
  setRowKeys: (rowKeys: readonly string[]) => void;
}

function holdUnderTest(): HoldUnderTest {
  const anchor = new ReadingAnchor();
  const scroll = new LedgerScrollController({ clock: new ManualClock() });
  const surface = countingSurface({ initialScrollTop: 0 });
  scroll.attach(surface);
  let rowKeys: readonly string[] = [];
  let immediateHolds = 0;
  const hold = new LedgerDeferredHold({
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
    surface,
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

describe("LedgerDeferredHold — which arm a reconcile arms", () => {
  it("holds the anchored position immediately when nothing was deferred", () => {
    const subject = holdUnderTest();
    scrollAwayFromTail(subject.anchor);

    subject.hold.armAfterReconcile({
      headInsertedCount: 0,
      previousHeadKey: "a",
      scrollTopPx: 200,
    });

    expect(subject.immediateHolds()).toBe(1);
    subject.hold.commit();
    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
  });

  it("defers the tail glide while following, and performs it on commit", () => {
    const subject = holdUnderTest();

    subject.hold.armAfterReconcile({ headInsertedCount: 0, previousHeadKey: "a", scrollTopPx: 0 });
    expect(subject.scroll.writeCount("follow-tail")).toBe(0);

    subject.hold.commit();
    expect(subject.scroll.writeCount("follow-tail")).toBe(1);
  });

  it("negative control: drops a deferred tail glide the reader scrolled away from", () => {
    const subject = holdUnderTest();
    subject.hold.armAfterReconcile({ headInsertedCount: 0, previousHeadKey: "a", scrollTopPx: 0 });
    scrollAwayFromTail(subject.anchor);

    subject.hold.commit();

    expect(subject.scroll.writeCount("follow-tail")).toBe(0);
  });

  it("holds the head row where it was when a page landed in front of it", () => {
    const subject = holdUnderTest();
    scrollAwayFromTail(subject.anchor);
    // Three rows arrived in front of `d`, which is now at index 3.
    subject.setRowKeys(["a", "b", "c", "d", "e"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 3,
      previousHeadKey: "d",
      scrollTopPx: 120,
    });
    // Nothing is written before the commit: the offset below is arithmetic in the
    // POST-insert space, which the virtualizer has not answered in yet.
    expect(subject.scroll.writeCount("hold-reading-position")).toBe(0);
    expect(subject.immediateHolds()).toBe(0);

    subject.hold.commit();

    // 3 rows above it at 40px each, plus where the reader already was.
    expect(subject.surface.scrollTop).toBe(3 * ROW_HEIGHT_PX + 120);
    expect(subject.scroll.writeCount("hold-reading-position")).toBe(1);
  });

  it("holds the head row even for a reader who was at the tail", () => {
    // The case the reading anchor cannot serve: a follower's anchor point is never
    // captured, so an arm that read one would leave exactly this reader unheld — and
    // a reader at the tail is the likeliest one to press for history.
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b", "c"]);

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "c",
      scrollTopPx: 80,
    });
    subject.hold.commit();

    expect(subject.surface.scrollTop).toBe(2 * ROW_HEIGHT_PX + 80);
    expect(subject.scroll.writeCount("follow-tail")).toBe(0);
  });

  it("negative control: writes nothing when the head row left the window", () => {
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

  it("performs each arming once, and nothing on a commit that armed nothing", () => {
    const subject = holdUnderTest();
    subject.setRowKeys(["a", "b"]);
    subject.hold.armAfterReconcile({ headInsertedCount: 1, previousHeadKey: "b", scrollTopPx: 0 });

    subject.hold.commit();
    subject.hold.commit();
    subject.hold.commit();

    expect(subject.scroll.writeCount("hold-reading-position")).toBe(1);
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

describe("LedgerDeferredHold — three windows, two pages, one row under the reader", () => {
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
    // THE WHOLE POINT OF THE ARM, stated as the thing a person would notice. Each page
    // lands ABOVE the reader and pushes every row below it down by its own height, so
    // without the hold the viewport shows whatever row happens to fall at the old
    // offset — three rows earlier the first time and two more the second.
    const subject = holdUnderTest();
    scrollAwayFromTail(subject.anchor);
    subject.setRowKeys(FIRST_WINDOW);
    subject.surface.scrollTop = READING_AT_PX;
    expect(rowAtViewportTop(FIRST_WINDOW, subject.surface.scrollTop)).toBe("r42");

    subject.hold.armAfterReconcile({
      headInsertedCount: 3,
      previousHeadKey: "r40",
      scrollTopPx: subject.surface.scrollTop,
    });
    subject.setRowKeys(AFTER_FIRST_PAGE);
    subject.hold.commit();
    expect(rowAtViewportTop(AFTER_FIRST_PAGE, subject.surface.scrollTop)).toBe("r42");

    subject.hold.armAfterReconcile({
      headInsertedCount: 2,
      previousHeadKey: "r35",
      scrollTopPx: subject.surface.scrollTop,
    });
    subject.setRowKeys(AFTER_SECOND_PAGE);
    subject.hold.commit();
    expect(rowAtViewportTop(AFTER_SECOND_PAGE, subject.surface.scrollTop)).toBe("r42");
  });

  it("negative control: the same two pages with no hold walk the reader backwards", () => {
    // Arming with nothing inserted is the frame as it behaved before this arm existed.
    // The offset does not move, so the rows that arrived above it take the reader with
    // them — which is what makes the case above an assertion rather than a tautology.
    const subject = holdUnderTest();
    scrollAwayFromTail(subject.anchor);
    subject.setRowKeys(FIRST_WINDOW);
    subject.surface.scrollTop = READING_AT_PX;

    subject.hold.armAfterReconcile({
      headInsertedCount: 0,
      previousHeadKey: "r40",
      scrollTopPx: subject.surface.scrollTop,
    });
    subject.setRowKeys(AFTER_FIRST_PAGE);
    subject.hold.commit();

    expect(rowAtViewportTop(AFTER_FIRST_PAGE, subject.surface.scrollTop)).toBe("r37");
  });
});
