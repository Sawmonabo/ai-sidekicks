// A long table drawn as a window over its rows, while its rows change height above the reader and
// its body narrows, in the engine that lays them out: the rows being read stay where they are, and
// the table never runs past its body.

import { act } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";

import { MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { PaintedFrameReader } from "../painted-frames.js";
import { benchTable, replyWith, settleTableWindow } from "./long-table.js";
import {
  mountBodies,
  SCROLLER_HEIGHT_PX,
  scrollToEnd,
  settleFrames,
  type MountedBodies,
} from "./reply.js";

/** How far a row read may move and still stand where it stood: the scroller's whole pixel. */
const HELD_PLACE_TOLERANCE_PX = 1;
/** Half-screen steps a reader reads upward in, from the table's end. */
const READ_UP_STEPS = 8;
/** What a drawn row adds below its cells that no estimate knows of, in CSS pixels. */
const DRAWN_ROW_EXTRA_PX = 12;
/** The body's width once it narrows, in CSS pixels; the table's columns were held wider. */
const NARROWED_BODY_WIDTH_PX = 420;
/** The frames watched after the body narrows, past the columns' measurement at its width. */
const NARROWED_FRAME_COUNT = 30;

const DRAWN_ROW_SELECTOR = `tr[${MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE}]`;

/** The table the scroller draws as a window, past any hidden frame a measurement draws. */
function windowedTableOf(bodies: MountedBodies): HTMLTableElement {
  return (
    bodies.windowedBody.querySelector<HTMLTableElement>("table[aria-rowcount]") ??
    expect.fail("the table draws as a window")
  );
}

/** The drawn row reaching below the middle of the scroller's box, by its index. */
function rowAtMiddleOf(bodies: MountedBodies): number {
  const box = bodies.scroller.getBoundingClientRect();
  const middlePx = box.top + box.height / 2;
  const row = [...windowedTableOf(bodies).querySelectorAll(DRAWN_ROW_SELECTOR)].find(
    (drawn) => drawn.getBoundingClientRect().bottom > middlePx,
  );
  return Number(
    row?.getAttribute(MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE) ?? expect.fail("a row is drawn mid-box"),
  );
}

/** Body row `index`'s top below the scroller's top, as drawn now. */
function rowTopPx(bodies: MountedBodies, index: number): number {
  const row =
    windowedTableOf(bodies).querySelector(
      `tr[${MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE}="${String(index)}"]`,
    ) ?? expect.fail(`body row ${String(index)} is drawn`);
  return row.getBoundingClientRect().top - bodies.scroller.getBoundingClientRect().top;
}

/** Adds `css` to the page until the test ends. */
function addStyle(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  onTestFinished(() => {
    style.remove();
  });
}

describe("browser — a long table's rows changing height above the reader", () => {
  it("keeps the row being read still as rows above it draw, and as fonts that loaded lay every row out anew", async () => {
    // Drawn rows stand taller than any estimate, which reads the cells' type from rows that carry
    // no index, so each row drawn above the reader moves every row below it.
    addStyle(`${DRAWN_ROW_SELECTOR} td { padding-bottom: ${String(DRAWN_ROW_EXTRA_PX)}px; }`);
    const bodies = await mountBodies(replyWith(benchTable(303)), {
      isComplete: true,
      drawsFlowBody: false,
    });
    await bodies.windowedBody.ownerDocument.fonts.ready;
    await settleTableWindow(bodies);
    const { scroller } = bodies;
    await scrollToEnd(scroller);
    let heldPx = 0;
    for (let step = 0; step < READ_UP_STEPS; step += 1) {
      const readAtPx = scroller.scrollTop - SCROLLER_HEIGHT_PX / 2;
      scroller.scrollTop = readAtPx;
      const index = rowAtMiddleOf(bodies);
      const topPx = rowTopPx(bodies, index);
      await settleFrames();
      expect(Math.abs(rowTopPx(bodies, index) - topPx), `step ${String(step)}`).toBeLessThanOrEqual(
        HELD_PLACE_TOLERANCE_PX,
      );
      heldPx += scroller.scrollTop - readAtPx;
    }
    // The control: rows above the reader did draw taller than estimated, and the scroller moved.
    expect(heldPx).toBeGreaterThan(DRAWN_ROW_EXTRA_PX);

    // A font that finished loading measures the columns again, and every row the window does not
    // draw goes back to its estimate, shorter than it was measured.
    const index = rowAtMiddleOf(bodies);
    const topPx = rowTopPx(bodies, index);
    const scrollTopPx = scroller.scrollTop;
    act(() => {
      bodies.windowedBody.ownerDocument.fonts.dispatchEvent(new Event("loadingdone"));
    });
    await settleTableWindow(bodies);
    expect(Math.abs(rowTopPx(bodies, index) - topPx)).toBeLessThanOrEqual(HELD_PLACE_TOLERANCE_PX);
    expect(scrollTopPx - scroller.scrollTop).toBeGreaterThan(DRAWN_ROW_EXTRA_PX);
  });
});

describe("browser — a long table whose body narrows", () => {
  it("never runs past its body in any frame before its columns are measured at the new width", async () => {
    const bodies = await mountBodies(replyWith(benchTable(304)), {
      isComplete: true,
      drawsFlowBody: false,
    });
    await bodies.windowedBody.ownerDocument.fonts.ready;
    await settleTableWindow(bodies);
    const { windowedBody } = bodies;
    expect(windowedTableOf(bodies).getBoundingClientRect().width).toBeGreaterThan(
      NARROWED_BODY_WIDTH_PX,
    );

    const overrunsPx: number[] = [];
    const frames = new PaintedFrameReader(
      DRAWN_ROW_SELECTOR,
      () =>
        windowedTableOf(bodies).getBoundingClientRect().right -
        windowedBody.getBoundingClientRect().right,
      (overrunPx) => {
        overrunsPx.push(overrunPx);
      },
    );
    windowedBody.style.width = `${String(NARROWED_BODY_WIDTH_PX)}px`;
    try {
      for (let frame = 0; frame < NARROWED_FRAME_COUNT; frame += 1) {
        await settleFrames();
      }
    } finally {
      frames.stop();
    }

    expect(overrunsPx.length).toBeGreaterThan(0);
    expect(overrunsPx.filter((overrunPx) => overrunPx > 0.5)).toStrictEqual([]);
  });
});
