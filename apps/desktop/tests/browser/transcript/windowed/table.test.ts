// A long markdown table drawn as a window over its rows, against the same table drawn whole, in the
// engine that lays them out. The claims are about column widths, row heights, what a selection
// keeps and copies, what the rows not drawn look like, and what assistive technology is told, none
// of which a DOM shim can answer.

import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";

import { TEXT_SIZES } from "#shared/appearance.js";

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import {
  openPagedSessionStore,
  pagedSessionEventAt,
} from "#renderer/features/transcript/logs.test-support.js";
import {
  COPY_FLAVOR_ATTRIBUTE,
  readSelectedPart,
} from "#renderer/features/transcript/copy/conversation-selection.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { BlockWindowLayout } from "#renderer/features/transcript/rows/markdown/block-window/layout.js";
import { MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { type TablePlacementChange } from "#renderer/features/transcript/rows/markdown/table-window/context.js";
import { FlowBodyPlacement } from "#renderer/features/transcript/rows/markdown/table-window/flow-body-placement.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
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
import { readerScrollsTo } from "#test/helpers/transcript/reader-scroll.js";
import { mountTranscriptFeed } from "../long-tool-feed.js";
import { hearResizeLoopErrors } from "../resize-loop-errors.js";

/** The height of what a row draws above its body, in CSS pixels. */
const LEAD_HEIGHT_PX = 48;
/** The width of the body below it, in CSS pixels. */
const LEAD_BODY_WIDTH_PX = 600;
/** The body's width once its row narrows, in CSS pixels. */
const NARROWED_BODY_WIDTH_PX = 480;

/** The rows of the table a reply in the conversation holds. */
const LISTED_TABLE_ROW_COUNT = 200;

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

/**
 * Waits until the conversation holds still: no long table measuring and its scroll height and
 * offset the same for `STILL_FRAMES` frames in a row. Throws past `STILL_ROUNDS` frames.
 */
async function settleConversation(scroller: HTMLElement): Promise<void> {
  let held = "";
  let stillFrames = 0;
  for (let round = 0; round < STILL_ROUNDS; round += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const now = `${String(scroller.scrollHeight)} ${String(scroller.scrollTop)}`;
    const isMeasuring = scroller.querySelector(".meridian-table-sample-frame") !== null;
    stillFrames = now === held && !isMeasuring ? stillFrames + 1 : 0;
    held = now;
    if (stillFrames === STILL_FRAMES) {
      return;
    }
  }
  throw new Error("the conversation never held still");
}

/** How many frames in a row with nothing moving count as the conversation holding still. */
const STILL_FRAMES = 10;

/** How many frames the conversation may take to hold still before a case gives up. */
const STILL_ROUNDS = 600;

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
    (sourceKey) => bodies.drawnSources.sourceOf(sourceKey),
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
  return (
    await readSelectedPart(
      wholeRange,
      rowOf(flowBody),
      () => reply,
      markdownWorker,
      () => expect.fail("the table drawn whole draws every row"),
    )
  ).text;
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

  it("draws a table that joins a short reply after its body was laid out with no table to tell", async () => {
    const lead = "A reply that holds no table yet.\n\n";
    const bodies = await mountBodies(lead, { isComplete: false, drawsFlowBody: false });
    // The body keeps this size from here on: laid out once more with no table listening, it is
    // not laid out again when the table joins, so the table reads the body's type when it asks.
    bodies.windowedBody.style.height = `${String(SCROLLER_HEIGHT_PX * 30)}px`;
    await settleFrames();
    act(() => {
      bodies.handle.setText?.(`${lead}${replyWith(benchTable(80))}`);
    });
    await settleTableWindow(bodies);
    const table = bodies.windowedBody.querySelector("table") ?? expect.fail("the table is drawn");

    expect(drawnRows(table).size).toBeGreaterThan(0);
    expect(table.getAttribute("aria-rowcount")).toBe("81");
  });

  it("places and tells a table at once when its body was laid out before the table listened", async () => {
    // A row and its table mount in one commit whose effects wait out a frame: the table asks the
    // body's type while the body is unattached, the body is laid out with no table listening, and
    // the table listens only after. Its next scroll sample asks the body's top, and the body tells
    // it of that layout before the next paint, though the body is not laid out again.
    const { body, placement } = flowBodyOnPage();
    const heard: { readonly widthPx: number | undefined; readonly topPx: number | undefined }[] =
      [];

    expect(placement.bodyType).toBeUndefined();
    const seenLayoutCount = placement.layoutCount;
    placement.attachBody(body);
    await settleFrames();
    placement.subscribeToPlacement(() => {
      heard.push({ widthPx: placement.bodyType?.widthPx, topPx: placement.anchorTopPx() });
    }, seenLayoutCount);

    expect(placement.anchorTopPx()).toBe(LEAD_HEIGHT_PX);
    await settleFrames();
    expect(heard).toStrictEqual([{ widthPx: LEAD_BODY_WIDTH_PX, topPx: LEAD_HEIGHT_PX }]);
  });

  it("tells a table in a windowed body of a layout the body made before the table listened", async () => {
    // As in a body drawn whole: the body is laid out with no table listening, the table listens
    // only after, and the body is not laid out again.
    const row = document.createElement("div");
    row.setAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE, "0");
    const body = document.createElement("div");
    body.style.width = `${String(LEAD_BODY_WIDTH_PX)}px`;
    body.textContent = "A long reply drawn as a window over its blocks.";
    row.append(body);
    document.body.append(row);
    onTestFinished(() => {
      row.remove();
    });
    const scrollController = new ScrollController({ clock: new ManualClock() });
    const layout = new BlockWindowLayout({
      viewport: suiteWindowViewport(scrollController, {
        subscribe: () => () => {},
        read: () => undefined,
      }),
      rowKey: "reply",
      blocks: {
        settledBlocks: [],
        volatileTail: "",
        tailNodes: undefined,
        readBlockSource: () => "",
        readDefinitionPreamble: () => "",
      },
      bodyTextLength: 0,
    });
    const heard: { readonly change: TablePlacementChange; readonly widthPx: number | undefined }[] =
      [];

    const seenLayoutCount = layout.layoutCount;
    layout.attachBody(body);
    await settleFrames();
    layout.subscribeToPlacement((change) => {
      heard.push({ change, widthPx: layout.bodyType?.widthPx });
    }, seenLayoutCount);
    await settleFrames();

    expect(heard).toStrictEqual([{ change: "laid-out", widthPx: LEAD_BODY_WIDTH_PX }]);
  });

  it("tells a second table of a layout it missed while the first table heard it", async () => {
    // The second table reads the body, the body is laid out at a new width while only the first
    // listens, and the second listens only after.
    const { body, placement } = flowBodyOnPage();
    const heardBySecond: (number | undefined)[] = [];
    placement.attachBody(body);
    placement.subscribeToPlacement(() => {}, placement.layoutCount);
    await settleFrames();

    expect(placement.bodyType?.widthPx).toBe(LEAD_BODY_WIDTH_PX);
    const seenBySecond = placement.layoutCount;
    body.style.width = `${String(NARROWED_BODY_WIDTH_PX)}px`;
    await settleFrames();
    placement.subscribeToPlacement(() => {
      heardBySecond.push(placement.bodyType?.widthPx);
    }, seenBySecond);
    await settleFrames();

    expect(heardBySecond).toStrictEqual([NARROWED_BODY_WIDTH_PX]);
  });
  it("reads a reply's long table in the conversation at its middle and its head with no resize loop", async () => {
    const reply = replyWith(benchTable(LISTED_TABLE_ROW_COUNT));
    // A row the window lets go of, or a table that changes height, inside the conversation's
    // resize report raises a resize loop error.
    const resizeLoopErrors = hearResizeLoopErrors();
    const { scroller } = await mountTranscriptFeed(
      openPagedSessionStore(0, 0, undefined, (index) => ({
        ...pagedSessionEventAt(index),
        kind: "assistant.message",
        payload: { contentType: "text/markdown" },
        content: { status: "available", body: reply },
      })),
      undefined,
    );
    await waitFor(() => {
      expect(scroller.querySelector("table[aria-rowcount]")).not.toBe(null);
    });
    await settleConversation(scroller);
    for (const scrollTopPx of [Math.round(scroller.scrollHeight / 2), 0]) {
      act(() => {
        readerScrollsTo(scroller, scrollTopPx);
      });
      await settleConversation(scroller);
    }
    expect(resizeLoopErrors.stop()).toStrictEqual([]);
  });
});

/**
 * A body drawn whole in a row, below `LEAD_HEIGHT_PX` of the row's own, and its placement, which
 * has not been handed the body yet; both leave the page after the test.
 */
function flowBodyOnPage(): { readonly body: HTMLElement; readonly placement: FlowBodyPlacement } {
  const row = document.createElement("div");
  row.setAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE, "0");
  const lead = document.createElement("div");
  lead.style.height = `${String(LEAD_HEIGHT_PX)}px`;
  const text = "A reply whose long table mounts with it.";
  const body = document.createElement("div");
  body.style.width = `${String(LEAD_BODY_WIDTH_PX)}px`;
  body.textContent = text;
  row.append(lead, body);
  document.body.append(row);
  onTestFinished(() => {
    row.remove();
  });
  const viewport = suiteWindowViewport(new ScrollController({ clock: new ManualClock() }), {
    subscribe: () => () => {},
    read: () => undefined,
  });
  const placement = new FlowBodyPlacement(
    viewport,
    "reply",
    { settledBlocks: [], volatileTail: text, readDefinitionPreamble: () => "" },
    text.length,
  );
  return { body, placement };
}
