// The reading anchor's three states and the promise underneath them. Geometry is supplied as
// values: the anchor is a fold over samples, and where a sample came from is the chokepoint's test.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_GESTURE_GAP_MS } from "./caps.js";
import { ReadingAnchor } from "./reading-anchor.js";
import type { ScrollGeometry, GeometryChangeCause } from "#renderer/lib/scroll/geometry/sample.js";

function geometry(
  scrollTop: number,
  isAtTail: boolean,
  cause: GeometryChangeCause = "scroll",
  inputAt?: number,
): ScrollGeometry {
  return {
    scrollTop,
    viewportHeight: 500,
    contentHeight: 5000,
    distanceFromTailPx: isAtTail ? 0 : 4500 - scrollTop,
    isAtTail,
    inputAt,
    cause,
  };
}

/** The reader's wheel at `inputAtMs`, then the scroll it makes to `scrollTop`. */
function readerScrollsTo(anchor: ReadingAnchor, scrollTop: number, inputAtMs = 1_000): void {
  anchor.noteReaderInput(inputAtMs);
  anchor.observeGeometry(geometry(scrollTop, scrollTop >= 4500, "scroll", inputAtMs + 8));
}

describe("the reading anchor — the three states", () => {
  it("follows until the reader leaves the tail, then holds and counts", () => {
    const anchor = new ReadingAnchor();
    expect(anchor.state.mode).toBe("following");

    anchor.noteAppendedRows(3);
    // While following, arriving rows are about to be on screen; a pill offering them is noise.
    expect(anchor.state.newRowCount).toBe(0);

    readerScrollsTo(anchor, 1200);
    expect(anchor.state.mode).toBe("reading");

    anchor.noteAppendedRows(2);
    anchor.noteAppendedRows(1);
    expect(anchor.state).toMatchObject({ mode: "reading-with-new-rows", newRowCount: 3 });
  });

  it("resumes following on reaching the tail, and clears the count with it", () => {
    const anchor = new ReadingAnchor();
    readerScrollsTo(anchor, 1200);
    anchor.noteAppendedRows(4);
    anchor.observeGeometry(geometry(4500, true));
    expect(anchor.state).toMatchObject({ mode: "following", newRowCount: 0 });
  });

  it("resumes following on the pill", () => {
    const anchor = new ReadingAnchor();
    readerScrollsTo(anchor, 1200);
    anchor.noteAppendedRows(9);
    expect(anchor.resumeFollowing()).toBe("following");
    expect(anchor.state).toMatchObject({ mode: "following", newRowCount: 0 });
  });
});

describe("the reading anchor — distance from the tail the reader did not make", () => {
  it("keeps following through a scroll toward the head that no input of the reader's made", () => {
    // A write by the transcript or the library publishes a sample with no event stamp; a scroll
    // event a gesture gap after the reader's last input is not that input's.
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(4500, true));
    anchor.observeGeometry(geometry(4400, false));
    expect(anchor.state.mode).toBe("following");
    anchor.noteReaderInput(1_000);
    anchor.observeGeometry(geometry(4300, false, "scroll", 1_000 + TRANSCRIPT_GESTURE_GAP_MS + 1));
    expect(anchor.state.mode).toBe("following");

    // A drag on the scrollbar sends no other input: while the pointer is down the scroll is theirs.
    anchor.notePointerDown(true);
    anchor.observeGeometry(geometry(4200, false, "scroll", 5_000));
    expect(anchor.state.mode).toBe("reading");
  });

  it("keeps following when the box shrank rather than the reader moving", () => {
    // A shorter viewport raises the distance from the tail on its own; folding that as "the
    // reader left the tail" would stop following because the window got smaller.
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(4500, true));
    anchor.observeGeometry(geometry(4500, false, "resize"));
    expect(anchor.state.mode).toBe("following");
  });

  it("keeps following when content grew under a still offset", () => {
    // A streaming last row grows before the virtualizer's end anchor catches up, so a write's
    // sample can read off the tail at an offset the reader never moved.
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(4500, true));
    anchor.observeGeometry({
      ...geometry(4500, false),
      contentHeight: 5300,
      distanceFromTailPx: 300,
    });
    expect(anchor.state.mode).toBe("following");
  });
});

describe("the reading anchor — holds", () => {
  it("holds rows a reader is engaged with, and releases them by key", () => {
    const anchor = new ReadingAnchor();
    anchor.hold("row-9", "selection");
    anchor.hold("row-4", "selection");
    expect(anchor.heldRowKeys()).toStrictEqual(["row-9", "row-4"]);
    expect(anchor.holdReason("row-9")).toBe("selection");
    expect(anchor.isHeld("row-2")).toBe(false);
    anchor.release("row-9");
    expect(anchor.heldRowKeys()).toStrictEqual(["row-4"]);
  });
});

describe("the reading anchor — the anchor point", () => {
  it("keeps the anchor point when the reader leaves the tail", () => {
    // Dropping it would leave the frame with nothing to restore on the first append after the
    // reader scrolled up.
    const anchor = new ReadingAnchor();
    anchor.capture({ rowKey: "row-7", offsetWithinViewportPx: 4 });
    readerScrollsTo(anchor, 1200);
    expect(anchor.state.anchorPoint?.rowKey).toBe("row-7");
  });
});
