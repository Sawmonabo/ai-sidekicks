// The reading anchor's three states and the promise underneath them. Geometry is supplied as
// values: the anchor is a fold over samples, and where a sample came from is the chokepoint's test.

import { describe, expect, it } from "vitest";

import { ReadingAnchor } from "./reading-anchor.js";
import type { ScrollGeometry, GeometryChangeCause } from "#renderer/lib/scroll/geometry-sample.js";

function geometry(
  scrollTop: number,
  isAtTail: boolean,
  cause: GeometryChangeCause = "scroll",
): ScrollGeometry {
  return {
    scrollTop,
    viewportHeight: 500,
    contentHeight: 5000,
    distanceFromTailPx: isAtTail ? 0 : 4500 - scrollTop,
    isAtTail,
    sampledAt: 0,
    cause,
  };
}

describe("the reading anchor — the three states", () => {
  it("follows until the reader leaves the tail, then holds and counts", () => {
    const anchor = new ReadingAnchor();
    expect(anchor.state.mode).toBe("following");

    anchor.noteAppendedRows(3);
    // While following, arriving rows are about to be on screen; a pill offering them is noise.
    expect(anchor.state.newRowCount).toBe(0);

    anchor.observeGeometry(geometry(1200, false));
    expect(anchor.state.mode).toBe("reading");

    anchor.noteAppendedRows(2);
    anchor.noteAppendedRows(1);
    expect(anchor.state).toMatchObject({ mode: "reading-with-new-rows", newRowCount: 3 });
  });

  it("resumes following on reaching the tail, and clears the count with it", () => {
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(1200, false));
    anchor.noteAppendedRows(4);
    anchor.observeGeometry(geometry(4500, true));
    expect(anchor.state).toMatchObject({ mode: "following", newRowCount: 0 });
  });

  it("resumes following on the pill, and unpins with it", () => {
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(1200, false));
    anchor.pin("cursor-40");
    anchor.noteAppendedRows(9);
    expect(anchor.resumeFollowing()).toBe("following");
    expect(anchor.state).toMatchObject({
      mode: "following",
      newRowCount: 0,
      pinnedRootCursor: undefined,
    });
  });
});

describe("the reading anchor — what a resize may and may not do", () => {
  it("keeps following when the box shrank rather than the reader moving", () => {
    // A shorter viewport raises the distance from the tail on its own; folding that as "the
    // reader left the tail" would stop following because the window got smaller.
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(4500, true));
    anchor.observeGeometry(geometry(4500, false, "resize"));
    expect(anchor.state.mode).toBe("following");
  });
});

describe("the reading anchor — pinning and holds", () => {
  it("suppresses prune only while pinned", () => {
    const anchor = new ReadingAnchor();
    expect(anchor.suppressesPrune()).toBe(false);
    anchor.pin("cursor-12");
    expect(anchor.suppressesPrune()).toBe(true);
    expect(anchor.state.pinnedRootCursor).toBe("cursor-12");
    anchor.unpin();
    expect(anchor.suppressesPrune()).toBe(false);
  });

  it("holds rows a reader is engaged with, and releases them by key", () => {
    const anchor = new ReadingAnchor();
    anchor.hold("row-9", "open-approval");
    anchor.hold("row-4", "selection");
    expect(anchor.heldRowKeys()).toStrictEqual(["row-9", "row-4"]);
    expect(anchor.holdReason("row-9")).toBe("open-approval");
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
    anchor.observeGeometry(geometry(1200, false));
    expect(anchor.state.anchorPoint?.rowKey).toBe("row-7");
  });
});

describe("the reading anchor — returning to the tail", () => {
  it("releases the pin, so prune resumes once the reader is done with history", () => {
    // Reaching the tail by scrolling and by the pill are one act; a pin only the pill released
    // would survive the other and keep prune refused.
    const anchor = new ReadingAnchor();
    anchor.pin("cursor-earlier");
    expect(anchor.suppressesPrune()).toBe(true);

    anchor.observeGeometry(geometry(4500, true));

    expect(anchor.suppressesPrune()).toBe(false);
    expect(anchor.state.pinnedRootCursor).toBeUndefined();
    expect(anchor.state.mode).toBe("following");
  });

  it("notifies on the release, so the window hears the refusal lift", () => {
    // The refusal is read off the published state, so an unannounced release would leave the
    // window deferring until something else notified.
    const anchor = new ReadingAnchor();
    anchor.pin("cursor-earlier");
    anchor.observeGeometry(geometry(1200, false));
    const seen: (string | undefined)[] = [];
    anchor.subscribe((state) => seen.push(state.pinnedRootCursor));

    anchor.observeGeometry(geometry(4500, true));

    expect(seen[0]).toBe("cursor-earlier");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.slice(1).every((pinnedRootCursor) => pinnedRootCursor === undefined)).toBe(true);
  });
});
