// The reading anchor's three states, and the promise underneath them.
//
// Geometry is supplied as values rather than measured, because the anchor's whole
// surface is a fold over geometry samples: what it does with a sample is the
// subject, and where the sample came from is the chokepoint's test.

import { describe, expect, it } from "vitest";

import { READING_HOLD_REASONS, READING_MODES, ReadingAnchor } from "./reading-anchor.js";
import type { LedgerGeometry } from "./scroll-chokepoint.js";

function geometry(scrollTop: number, isAtTail: boolean): LedgerGeometry {
  return {
    scrollTop,
    viewportHeight: 500,
    contentHeight: 5000,
    distanceFromTailPx: isAtTail ? 0 : 4500 - scrollTop,
    isAtTail,
    sampledAt: 0,
  };
}

describe("the reading anchor — the three states", () => {
  it("declares them closed, in the order the design names them", () => {
    expect([...READING_MODES]).toStrictEqual(["following", "reading", "reading-with-new-rows"]);
    expect([...READING_HOLD_REASONS]).toStrictEqual([
      "open-ask",
      "open-approval",
      "deep-link-target",
      "selection",
    ]);
  });

  it("follows until the reader leaves the tail, then holds and counts", () => {
    const anchor = new ReadingAnchor();
    expect(anchor.state.mode).toBe("following");

    anchor.noteAppendedRows(3);
    // While following, arriving rows are about to be on screen; a pill offering to
    // jump to them would be noise.
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

  it("negative control: a sample that is not at the tail does not resume following", () => {
    // The two cases above both end in `following`; without this one they would pass
    // over an anchor that followed unconditionally.
    const anchor = new ReadingAnchor();
    anchor.observeGeometry(geometry(1200, false));
    anchor.observeGeometry(geometry(1300, false));
    expect(anchor.state.mode).toBe("reading");
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

  it("pinning leaves following, because a pinned reader is reading", () => {
    const anchor = new ReadingAnchor();
    anchor.pin("cursor-12");
    expect(anchor.state.mode).toBe("reading");
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

  it("notifies once per change, and replays the current state on subscribe", () => {
    const anchor = new ReadingAnchor();
    const modes: string[] = [];
    anchor.subscribe((state) => modes.push(state.mode));
    expect(modes).toStrictEqual(["following"]);
    anchor.observeGeometry(geometry(900, false));
    // A second identical sample is not a change and must not cost a render.
    anchor.observeGeometry(geometry(900, false));
    expect(modes).toStrictEqual(["following", "reading"]);
  });
});

describe("the reading anchor — the anchor point", () => {
  it("keeps the last captured row and offset, and ignores a repeat", () => {
    const anchor = new ReadingAnchor();
    const captures: (string | undefined)[] = [];
    anchor.subscribe((state) => captures.push(state.anchorPoint?.rowKey));
    anchor.capture({ rowKey: "row-30", offsetWithinViewportPx: -18 });
    anchor.capture({ rowKey: "row-30", offsetWithinViewportPx: -18 });
    expect(captures).toStrictEqual([undefined, "row-30"]);
    expect(anchor.state.anchorPoint?.offsetWithinViewportPx).toBe(-18);
  });

  it("keeps the anchor point when the reader leaves the tail", () => {
    // Dropping it there would leave the frame with nothing to restore on the very
    // first append after the reader scrolled up.
    const anchor = new ReadingAnchor();
    anchor.capture({ rowKey: "row-7", offsetWithinViewportPx: 4 });
    anchor.observeGeometry(geometry(1200, false));
    expect(anchor.state.anchorPoint?.rowKey).toBe("row-7");
  });
});
