// A long markdown table drawn as a window over its rows, against the same table drawn whole, in the
// engine that lays them out. The claims are about column widths, row heights, what a selection
// keeps and copies, what the rows not drawn look like, and what assistive technology is told, none
// of which a DOM shim can answer.

import { act } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";

import { TEXT_SIZES } from "#shared/appearance.js";

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import {
  COPY_FLAVOR_ATTRIBUTE,
  readSelectedPart,
} from "#renderer/features/transcript/copy/conversation-selection.js";
import { MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { READING_LINE_HEIGHT } from "#renderer/styles/typography.js";
import {
  benchRow,
  benchTable,
  drawnRows,
  expectSameLayout,
  headWidthsOf,
  mountWithWhole,
  PLANTED_ROWS,
  replyWith,
  SAME_LENGTH_TOLERANCE_PX,
  scrollToRow,
  settleTableWindow,
  TABLE_HEAD,
  tablesOf,
} from "./long-table.js";
import {
  flingShowingSpacers,
  mountBodies,
  SCROLLER_HEIGHT_PX,
  scrollTo,
  settleFrames,
  textEnds,
  type MountedBodies,
} from "./reply.js";

/** A table long enough that the fastest fling ends inside it. */
const FLUNG_TABLE_ROW_COUNT = 3_000;

/** A table of `rowCount` rows whose every cell is a word, so each row draws on one line. */
function oneLineTable(rowCount: number): string {
  return [
    "| Lane | State |",
    "| :--- | :---- |",
    ...Array.from({ length: rowCount }, (_, index) => `| lane-${String(index)} | done |`),
  ].join("\n");
}
/** The screens a fling must travel for its frames to have crossed the window's edge many times. */
const FLING_MINIMUM_SCREENS = 3;

function drawnRow(table: HTMLTableElement, index: number): HTMLTableRowElement {
  const row = drawnRows(table).get(index);
  if (row === undefined) {
    throw new Error(`body row ${String(index)} is not drawn`);
  }
  return row;
}

/**
 * Each frame from now until the scroller's table first draws as a window: whether it draws whole,
 * and how far its height is from the whole table's. Throws past `FRAMES_TO_WINDOW` frames.
 */
async function framesUntilWindowed(
  bodies: MountedBodies,
): Promise<{ readonly drawsWhole: boolean; readonly heightGapPx: number }[]> {
  const frames: { readonly drawsWhole: boolean; readonly heightGapPx: number }[] = [];
  for (let frame = 0; frame < FRAMES_TO_WINDOW; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    const { windowed, whole } = tablesOf(bodies);
    const isWindowed = windowed.hasAttribute("aria-rowcount");
    frames.push({
      drawsWhole: !isWindowed,
      heightGapPx: Math.abs(
        windowed.getBoundingClientRect().height - whole.getBoundingClientRect().height,
      ),
    });
    if (isWindowed) {
      return frames;
    }
  }
  throw new Error("the table never drew as a window");
}

/** How many frames a table past the line may draw whole while its window is measured. */
const FRAMES_TO_WINDOW = 200;

/**
 * Selects from inside body row `firstIndex`'s first cell to the end of row `lastIndex`'s last
 * cell, the way a reader shift-clicks: press at the first, scroll straight to the last, never
 * drawing the rows between, and extend there. Returns the nodes the selection's ends stand in.
 */
async function selectAcrossRows(
  bodies: MountedBodies,
  firstIndex: number,
  lastIndex: number,
): Promise<{ readonly start: Text; readonly end: Text }> {
  const { windowed } = tablesOf(bodies);
  const selection = document.getSelection() ?? expect.fail("the document has a selection");
  await scrollToRow(bodies, firstIndex);
  const start = textEnds(drawnRow(windowed, firstIndex)).first;
  // A press: a caret, which the window keeps drawn while the reader scrolls to the shift-click.
  selection.collapse(start, 2);
  await settleFrames();
  await scrollToRow(bodies, lastIndex);
  const end = textEnds(drawnRow(windowed, lastIndex)).last;
  selection.extend(end, end.length);
  await settleFrames();
  return { start, end };
}

/** The row a body is drawn in: the element holding the body's copy flavor. */
function rowOf(body: HTMLElement): Element {
  return (
    body.closest(`[${COPY_FLAVOR_ATTRIBUTE}]`)?.parentElement ??
    expect.fail("the body is drawn in a row")
  );
}

/** The markdown a selection in the windowed reply copies, read as the conversation's copy does. */
async function copiedFromWindowed(bodies: MountedBodies, reply: string): Promise<string> {
  const selection = document.getSelection() ?? expect.fail("the document has a selection");
  const { text: copied } = await readSelectedPart(
    selection.getRangeAt(0),
    rowOf(bodies.windowedBody),
    () => reply,
    markdownWorker,
  );
  selection.removeAllRanges();
  return copied;
}

/** The markdown the same rows copy as from the table drawn whole. */
async function copiedFromWhole(
  bodies: MountedBodies,
  reply: string,
  firstIndex: number,
  lastIndex: number,
): Promise<string> {
  const { whole } = tablesOf(bodies);
  const wholeRange = document.createRange();
  const rows = whole.tBodies[0]?.rows;
  wholeRange.setStart(textEnds(rows?.[firstIndex] ?? expect.fail("first row")).first, 2);
  const end = textEnds(rows?.[lastIndex] ?? expect.fail("last row")).last;
  wholeRange.setEnd(end, end.length);
  const flowBody = bodies.flowBody ?? expect.fail("the whole reply is drawn");
  return (await readSelectedPart(wholeRange, rowOf(flowBody), () => reply, markdownWorker)).text;
}

describe("browser — a long table drawn as a window over its rows", () => {
  it.each([
    { rowCount: 49, lineHeight: "inherited" },
    { rowCount: 96, lineHeight: "inherited" },
    { rowCount: 300, lineHeight: "inherited" },
    { rowCount: 3_078, lineHeight: "inherited" },
    // A page in quirks mode, as a window opened on `about:blank` is, sets a table's to `normal`;
    // a table of its own, so no geometry remembered from the case above is taken.
    { rowCount: 301, lineHeight: "normal" },
    // A reply's own line height, whose lines fall between the layout's 1/64 px steps, so an undrawn
    // row estimated from anything but laid-out lines drifts from the whole table row by row; a
    // table of its own too.
    { rowCount: 302, lineHeight: "reading" },
  ] as const)(
    "lays out $rowCount rows, line height $lineHeight, at the whole table's column widths and row heights, wherever the window stands",
    async ({ rowCount, lineHeight }) => {
      if (lineHeight !== "inherited") {
        const style = document.createElement("style");
        style.textContent = `.meridian-markdown__table { line-height: ${lineHeight === "normal" ? "normal" : String(READING_LINE_HEIGHT)}; }`;
        document.head.append(style);
        onTestFinished(() => {
          style.remove();
        });
      }
      const bodies = await mountWithWhole(replyWith(benchTable(rowCount)), { isComplete: true });
      const { windowed } = tablesOf(bodies);
      let comparedRows = expectSameLayout(bodies, "at the top");
      const stops = [
        Math.floor(rowCount / 2),
        ...PLANTED_ROWS.map((planted) => rowCount - planted.fromEnd),
        rowCount - 1,
      ];
      for (const index of stops) {
        await scrollToRow(bodies, index);
        expect(drawnRows(windowed).has(index), `row ${String(index)} drawn`).toBe(true);
        comparedRows += expectSameLayout(bodies, `at row ${String(index)}`);
      }
      // Back at the top, the rows above every stop were measured on the way down and back.
      await scrollTo(bodies.scroller, 0);
      comparedRows += expectSameLayout(bodies, "back at the top");
      expect(comparedRows).toBeGreaterThan(stops.length);
      expect(drawnRows(windowed).size).toBeLessThan(rowCount);
    },
  );

  it("matches the whole table as a streaming table crosses the window's line, and when a later row widens a column", async () => {
    const rows = Array.from({ length: 70 }, (_, index) => benchRow(index));
    const tableOf = (count: number): string => [...TABLE_HEAD, ...rows.slice(0, count)].join("\n");
    const bodies = await mountWithWhole(replyWith(tableOf(40)), { isComplete: false });
    const { windowed } = tablesOf(bodies);
    expect(windowed.hasAttribute("aria-rowcount")).toBe(false);

    // Past the line the table keeps drawing whole while its window is measured, then swaps to the
    // window in one frame, as tall as the whole table in every frame.
    bodies.handle.setText?.(replyWith(tableOf(60)));
    const frames = await framesUntilWindowed(bodies);
    expect(frames.filter((frame) => frame.drawsWhole).length).toBeGreaterThan(0);
    for (const [index, frame] of frames.entries()) {
      expect(frame.heightGapPx, `frame ${String(index)}`).toBeLessThanOrEqual(
        SAME_LENGTH_TOLERANCE_PX,
      );
    }
    await settleTableWindow(bodies);
    expect(tablesOf(bodies).windowed.getAttribute("aria-rowcount")).toBe("61");
    expectSameLayout(bodies, "at the crossing");

    // A row whose cells are wider than any above, every column measured again as whole; its last,
    // of capitals whose pairs kern, sets its column to the width it takes once kerned.
    rows[60] =
      "| 読者位置表示 | **WMWMWMWMWM** | `MWMWM` | 0.61 | AVAWAYATAVAWAYATAVAWAYATAVAWAYAT |";
    const before = headWidthsOf(tablesOf(bodies).windowed);
    bodies.handle.setText?.(replyWith(tableOf(61)));
    await settleTableWindow(bodies);
    expect(headWidthsOf(tablesOf(bodies).windowed)).not.toStrictEqual(before);
    expectSameLayout(bodies, "after a widening row");
    await scrollToRow(bodies, 60);
    expectSameLayout(bodies, "at the widening row");
  });

  it("shows no spacer in any frame of the fastest fling over one-line rows at the smallest text size, and draws a spacer with no cell", async () => {
    // The shortest rows a table draws: one line each, at the smallest text size a person can pick.
    document.documentElement.style.fontSize = `${String(Math.min(...TEXT_SIZES))}px`;
    onTestFinished(() => {
      document.documentElement.style.removeProperty("font-size");
    });
    const bodies = await mountWithWhole(replyWith(oneLineTable(FLUNG_TABLE_ROW_COUNT)), {
      isComplete: true,
    });
    const { windowed } = tablesOf(bodies);
    const spacersOf = (): HTMLTableRowElement[] => [
      ...windowed.querySelectorAll<HTMLTableRowElement>("tr[data-table-spacer]"),
    ];

    const shownPxByFrame = await flingShowingSpacers(
      bodies.scroller,
      `[${MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE}]`,
      spacersOf,
    );

    // The controls: the fling crossed screens of rows the window had not drawn, and the window
    // still holds the room of the rows it does not draw.
    expect(bodies.scroller.scrollTop).toBeGreaterThan(FLING_MINIMUM_SCREENS * SCROLLER_HEIGHT_PX);
    expect(spacersOf().length).toBeGreaterThan(0);
    expect(shownPxByFrame).toEqual([]);
    // A spacer draws no cell, so no border or ground of one ever reaches the screen.
    expect(spacersOf().map((spacer) => spacer.cells.length)).toEqual(spacersOf().map(() => 0));
  });

  it("tells assistive technology each drawn row's place in the whole table", async () => {
    const bodies = await mountWithWhole(replyWith(benchTable(400)), { isComplete: true });
    const { windowed, whole } = tablesOf(bodies);
    await scrollToRow(bodies, 200);
    expect(windowed.getAttribute("aria-rowcount")).toBe("401");
    const placed = [...windowed.querySelectorAll<HTMLTableRowElement>("tr[aria-rowindex]")];
    expect(
      placed.some((row) => row.getAttribute(MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE) === "200"),
    ).toBe(true);
    for (const row of placed) {
      const place = Number(row.getAttribute("aria-rowindex"));
      // The whole table's rows in order, its head row first, as aria-rowindex counts from one.
      expect(row.cells[0]?.textContent, `aria-rowindex ${String(place)}`).toBe(
        whole.rows[place - 1]?.cells[0]?.textContent,
      );
    }
    const spacers = [...(windowed.tBodies[0]?.rows ?? [])].filter(
      (row) => !row.hasAttribute("aria-rowindex"),
    );
    expect(spacers.length).toBeGreaterThan(0);
    expect(spacers.every((row) => row.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("keeps the rows holding a selection's ends drawn, and shows a row drawn between them as selected", async () => {
    const bodies = await mountWithWhole(replyWith(benchTable(400)), { isComplete: true });
    const { windowed } = tablesOf(bodies);
    const { start, end } = await selectAcrossRows(bodies, 2, 350);

    // The reader scrolls back to the middle, whose rows were never drawn while selecting.
    await scrollToRow(bodies, 180);

    const selection = document.getSelection() ?? expect.fail("the document has a selection");
    const drawn = drawnRows(windowed);
    expect([drawn.has(2), drawn.has(350)]).toStrictEqual([true, true]);
    expect(selection.anchorNode).toBe(start);
    expect(selection.focusNode).toBe(end);
    expect([start.isConnected, end.isConnected]).toStrictEqual([true, true]);
    const middleRow = drawnRow(windowed, 180);
    expect(selection.getRangeAt(0).comparePoint(middleRow, 0)).toBe(0);
    expect(selection.containsNode(middleRow, true)).toBe(true);
    selection.removeAllRanges();
  });

  it("copies a selection across rows never drawn whole, from the reply's text, as the table drawn whole copies it", async () => {
    const reply = replyWith(benchTable(400));
    const bodies = await mountWithWhole(reply, { isComplete: true });
    await selectAcrossRows(bodies, 2, 350);
    const copied = await copiedFromWindowed(bodies, reply);

    expect(copied).toBe(await copiedFromWhole(bodies, reply, 2, 350));
    expect(copied).toContain("lane-180");
    // The selection starts two letters into row 2 and keeps every row from 3 to 350 whole.
    expect(copied.match(/^\| lane-\d+ /gmu)?.length).toBe(348);
  });

  it("copies a selection of body rows as a table of those rows, with no head row and its columns' alignment", async () => {
    const reply = replyWith(benchTable(400));
    const bodies = await mountWithWhole(reply, { isComplete: true });
    await selectAcrossRows(bodies, 5, 8);
    const lines = (await copiedFromWindowed(bodies, reply)).split("\n");

    // Markdown has no table without a head row, so the rows paste under an empty one.
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^(\|\s*)+\|$/u);
    expect(lines[1]).toMatch(/^\|\s*:-+\s*\|\s*-+\s*\|\s*-+:\s*\|\s*-+:\s*\|\s*-+\s*\|$/u);
    expect(lines[2]).toMatch(/^\|\s*ne-5\s*\|\s*running\s*\|/u);
    expect(lines.slice(3).map((line) => /^\|\s*(lane-\d+)/u.exec(line)?.[1])).toStrictEqual([
      "lane-6",
      "lane-7",
      "lane-8",
    ]);
  });

  it("windows a table past the whole-draw line in a reply too short for the body's window", async () => {
    const reply = replyWith(benchTable(80));
    expect(reply.length).toBeLessThan(8_192);
    const bodies = await mountBodies(reply, { isComplete: true, drawsFlowBody: false });
    await settleTableWindow(bodies);
    const table = bodies.windowedBody.querySelector("table") ?? expect.fail("the table is drawn");
    await scrollTo(bodies.scroller, SCROLLER_HEIGHT_PX);

    expect(drawnRows(table).size).toBeGreaterThan(0);
    expect(drawnRows(table).size).toBeLessThan(80);
    expect(table.getAttribute("aria-rowcount")).toBe("81");
  });
});
