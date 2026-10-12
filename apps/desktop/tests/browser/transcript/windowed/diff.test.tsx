// A long diff opened whole inside a transcript viewport, drawn as a window over its steps of rows,
// in the engine that lays it out: only the steps near the view are drawn, its whole height laid out
// as the block drawn whole lays it out, its undrawn steps measured off screen; a selection dragged
// far past the window copies the same text the block drawn whole copies; assistive technology reads
// the drawn rows by their places in the block and never a spacer, and focus stays on the rows Show
// all opened; a reader below the block stays where they were while its steps are measured above
// them, the block growing outside every resize report; and a reader inside the block keeps the
// step they read when the rows' text size changes, the step before it ending just above them.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import {
  DrawnWindowSources,
  DrawnWindowSourcesContext,
  UNDRAWN_TEXT_SOURCE_ATTRIBUTE,
} from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import {
  diffOf,
  drawDiffCard,
  filePatch,
  type DrawnDiffCard,
} from "#renderer/features/repos/diff/components/InlineDiffCard.test-support.js";
import { DIFF_FLOW_STEP_ATTRIBUTE } from "#renderer/features/repos/diff/rows/flow.js";
import { readSelectedPart } from "#renderer/features/transcript/copy/conversation-selection.js";
import {
  SuiteWindowViewportProvider,
  suiteWindowViewport,
} from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { hearResizeLoopErrors } from "../resize-loop-errors.js";
import { letFramePaint, settleFrames } from "./reply.js";

/** The flow's box, in CSS pixels. */
const FLOW_HEIGHT_PX = 600;
const FLOW_WIDTH_PX = 560;

/** The long file's lines: far more than the window draws. */
const LINE_COUNT = 4_000;

/** The short files after the long one in the reader's case. */
const SHORT_FILE_COUNT = 8;

/** How far a row may land from where the reader saw it and still be the same place. */
const HELD_TOLERANCE_PX = 1;

/** The most rows the window may hold drawn at rest: the band's screens of rows, and its pins. */
const DRAWN_ROW_LIMIT = 1_000;

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  cleanup();
});

/** The card drawn in a viewport, and the sources a copy reads its undrawn rows from. */
interface WindowedCard extends DrawnDiffCard {
  readonly sources: DrawnWindowSources;
}

/**
 * Draws a card of `patches` in a scrolling flow inside a viewport, as the transcript draws a row's
 * card, the reader's selection read from the document.
 */
function drawInViewport(patches: readonly string[]): WindowedCard {
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const viewport = suiteWindowViewport(scrollController, {
    subscribe: (listener) => {
      document.addEventListener("selectionchange", listener);
      return () => {
        document.removeEventListener("selectionchange", listener);
      };
    },
    read: () => {
      const selection = document.getSelection();
      return selection === null || selection.rangeCount === 0 ? undefined : selection.getRangeAt(0);
    },
  });
  const sources = new DrawnWindowSources();
  const card = drawDiffCard(diffOf(patches), {
    heightPx: FLOW_HEIGHT_PX,
    widthPx: FLOW_WIDTH_PX,
    inViewport: (drawn) => (
      <SuiteWindowViewportProvider viewport={viewport}>
        {/* The controller follows the flow from the commit that mounts the card, as the
            transcript's follows its scroller before its rows draw. */}
        <span
          ref={(element) => {
            const flow = element?.closest<HTMLElement>("[data-flow]");
            if (flow !== null && flow !== undefined) {
              scrollController.attach(flow);
            }
          }}
        />
        <DrawnWindowSourcesContext value={sources}>{drawn}</DrawnWindowSourcesContext>
      </SuiteWindowViewportProvider>
    ),
  });
  return { ...card, sources };
}

/** Draws a card of `patches` outside any viewport, each block opened whole and filled. */
async function drawWhole(patches: readonly string[]): Promise<DrawnDiffCard> {
  const card = drawDiffCard(diffOf(patches), { heightPx: FLOW_HEIGHT_PX, widthPx: FLOW_WIDTH_PX });
  fireEvent.click(showAllOf(card.block));
  for (let frame = 0; card.block.querySelectorAll('[role="row"]').length < rowCountOf(card); ) {
    frame += 1;
    if (frame > 2_000) {
      expect.fail("the whole block never filled");
    }
    await settleFrames();
  }
  return card;
}

describe("browser — a long diff opened whole drawn as a window over its steps", () => {
  it("draws only the steps near the view, its whole height laid out as the block drawn whole", async () => {
    const windowed = drawInViewport([wrappingPatch(LINE_COUNT)]);
    fireEvent.click(showAllOf(windowed.block));
    await settleMeasuring();
    const windowedHeightPx = rowsOf(windowed.block).getBoundingClientRect().height;
    expect(windowed.block.querySelectorAll('[role="row"]').length).toBeLessThan(DRAWN_ROW_LIMIT);
    expect(
      windowed.block.querySelectorAll(`[${UNDRAWN_TEXT_SOURCE_ATTRIBUTE}]`).length,
    ).toBeGreaterThan(0);
    cleanup();

    const whole = await drawWhole([wrappingPatch(LINE_COUNT)]);
    expect(windowedHeightPx).toBeCloseTo(rowsOf(whole.block).getBoundingClientRect().height, 0);
  });

  it("copies a selection dragged far past the window as the block drawn whole copies it", async () => {
    const firstRow = 12;
    const lastRow = 3_517;
    const windowed = drawInViewport([wrappingPatch(LINE_COUNT)]);
    fireEvent.click(showAllOf(windowed.block));
    await settleMeasuring();
    const selection = document.getSelection() ?? expect.fail("the document has a selection");
    const start = await scrollToRow(windowed, firstRow);
    // A press: a caret, which the window keeps drawn while the reader scrolls to the far end.
    act(() => {
      selection.collapse(firstTextOf(start), 0);
    });
    await settleFrames();
    const end = await scrollToRow(windowed, lastRow);
    const endText = lastTextOf(end);
    act(() => {
      selection.extend(endText, endText.length);
    });
    await settleFrames();
    const range = selection.getRangeAt(0);
    // Most rows between the ends are not drawn: spacers stand for them inside the selection.
    const spacers = [...windowed.block.querySelectorAll(`[${UNDRAWN_TEXT_SOURCE_ATTRIBUTE}]`)];
    expect(spacers.some((spacer) => range.intersectsNode(spacer))).toBe(true);
    const copied = await readSelectedPart(
      range,
      rowOf(windowed.card),
      () => expect.fail("a diff draws no large body"),
      markdownWorker,
      (sourceKey) => windowed.sources.sourceOf(sourceKey),
    );
    selection.removeAllRanges();
    cleanup();

    const whole = await drawWhole([wrappingPatch(LINE_COUNT)]);
    const wholeRange = document.createRange();
    wholeRange.setStart(firstTextOf(rowAt(whole.block, firstRow)), 0);
    const wholeEnd = lastTextOf(rowAt(whole.block, lastRow));
    wholeRange.setEnd(wholeEnd, wholeEnd.length);
    const expected = await readSelectedPart(
      wholeRange,
      rowOf(whole.card),
      () => expect.fail("a diff draws no large body"),
      markdownWorker,
      () => expect.fail("a block drawn whole has no spacer"),
    );
    expect(copied.text).toBe(expected.text);
    // Every line between the ends is in it, by its own number.
    for (const lineNumber of [firstRow + 1, 1_900, lastRow + 1]) {
      expect(copied.text).toContain(`const value${String(lineNumber - 1)} =`);
    }
  });

  it("keeps focus on the rows Show all opened, and reads its drawn rows by their places, never a spacer", async () => {
    const windowed = drawInViewport([wrappingPatch(LINE_COUNT)]);
    fireEvent.click(showAllOf(windowed.block));
    await settleMeasuring();
    const rows = rowsOf(windowed.block);
    expect(document.activeElement).toBe(rows);
    expect(rows.getAttribute("aria-rowcount")).toBe(String(LINE_COUNT));
    for (const rowIndex of [0, 1_900, LINE_COUNT - 1]) {
      await scrollToRow(windowed, rowIndex);
      const drawn = [...rows.querySelectorAll<HTMLElement>('[role="row"]')];
      expect(drawn.length).toBeGreaterThan(0);
      // Each drawn row is the line its place names.
      for (const row of drawn) {
        const place = Number(row.getAttribute("aria-rowindex"));
        expect(row.textContent).toContain(`const value${String(place - 1)} =`);
      }
      // A spacer is hidden from assistive technology and holds no text to read.
      const spacers = [...rows.querySelectorAll(`[${UNDRAWN_TEXT_SOURCE_ATTRIBUTE}]`)];
      expect(spacers.length).toBeGreaterThan(0);
      for (const spacer of spacers) {
        expect(spacer.getAttribute("aria-hidden")).toBe("true");
        expect(spacer.textContent).toBe("");
      }
    }
    expect(document.activeElement).toBe(rows);
  });

  it("keeps a reader below the block still while its steps are measured above them", async () => {
    const shortFiles = Array.from({ length: SHORT_FILE_COUNT }, (_unused, ordinal) =>
      filePatch(`short-${String(ordinal)}.ts`, "@@ -1,3 +1,3 @@", [" a", "-b", "+B", " c"]),
    );
    const windowed = drawInViewport([wrappingPatch(1_200), ...shortFiles]);
    const { flow, card, block } = windowed;
    fireEvent.click(showAllOf(block));
    // One frame each, so most steps are still unmeasured when the watch below starts.
    await letFramePaint();
    // At once just past the long file's block, before its steps are measured.
    flow.scrollTop += block.getBoundingClientRect().bottom - flow.getBoundingClientRect().top + 20;
    await letFramePaint();
    expect(block.getBoundingClientRect().bottom).toBeLessThan(flow.getBoundingClientRect().top);
    const reference = firstRowOnScreen(card, flow);
    const readerTopPx = reference.getBoundingClientRect().top;
    const heightAtStartPx = block.getBoundingClientRect().height;

    // Where the reader's row stands each time the block resizes, read as the frame paints it.
    const movesPx: number[] = [];
    const growth = new ResizeObserver(() => {
      movesPx.push(reference.getBoundingClientRect().top - readerTopPx);
    });
    growth.observe(block);
    // The block grows outside the resize reports, so its own report is never held back.
    const resizeLoopErrors = hearResizeLoopErrors();
    await settleMeasuring();
    growth.disconnect();
    expect(resizeLoopErrors.stop()).toStrictEqual([]);
    expect(movesPx.length).toBeGreaterThan(1);
    for (const [frame, movedPx] of movesPx.entries()) {
      expect(Math.abs(movedPx), `moved ${String(movedPx)} at change ${String(frame)}`).toBeLessThan(
        HELD_TOLERANCE_PX,
      );
    }
    // The steps measured above the reader did grow the block while they read.
    expect(block.getBoundingClientRect().height - heightAtStartPx).toBeGreaterThan(FLOW_HEIGHT_PX);
  });

  it("keeps the step a reader reads in place when the rows' text size changes", async () => {
    const windowed = drawInViewport([wrappingPatch(1_200)]);
    const { flow, block } = windowed;
    fireEvent.click(showAllOf(block));
    await settleMeasuring();
    const rows = rowsOf(block);
    flow.scrollTop +=
      rows.getBoundingClientRect().top -
      flow.getBoundingClientRect().top +
      rows.getBoundingClientRect().height / 2;
    await settleFrames();
    // The first step starting on screen is brought to the reader's top, so the step before it
    // ends just above the reader.
    const flowTopPx = flow.getBoundingClientRect().top;
    const step =
      [...block.querySelectorAll<HTMLElement>(`[${DIFF_FLOW_STEP_ATTRIBUTE}]`)].find(
        (candidate) => candidate.getBoundingClientRect().top > flowTopPx,
      ) ?? expect.fail("no step starts on the flow's screen");
    flow.scrollTop += step.getBoundingClientRect().top - flowTopPx;
    await settleFrames();
    const stepNumber = step.getAttribute(DIFF_FLOW_STEP_ATTRIBUTE) ?? expect.fail("a step number");
    const readStep = (): HTMLElement =>
      block.querySelector<HTMLElement>(`[${DIFF_FLOW_STEP_ATTRIBUTE}="${stepNumber}"]`) ??
      expect.fail(`step ${stepNumber} is not drawn`);
    const readerTopPx = readStep().getBoundingClientRect().top;

    // A larger text size: every step wraps anew, the ones above the reader included.
    rows.style.fontSize = "15px";
    rows.style.lineHeight = "24px";
    await settleFrames();
    await settleMeasuring();
    expect(Math.abs(readStep().getBoundingClientRect().top - readerTopPx)).toBeLessThan(
      HELD_TOLERANCE_PX,
    );
  });
});

/**
 * One file of `lineCount` added lines, every tenth long enough to wrap onto several rows, so a
 * step's height is known only once it is laid out.
 */
function wrappingPatch(lineCount: number): string {
  const body: string[] = [];
  for (let ordinal = 0; ordinal < lineCount; ordinal += 1) {
    const tail = ordinal % 10 === 0 ? ` ${"wrapping words ".repeat(24)}` : "";
    body.push(`+const value${String(ordinal)} = compute(${String(ordinal)});${tail}`);
  }
  return filePatch("module.ts", `@@ -0,0 +1,${String(lineCount)} @@`, body);
}

/** Waits until no step has stood in the measuring frames for a few frames running. */
async function settleMeasuring(): Promise<void> {
  for (let quietRounds = 0, round = 0; quietRounds < 3; round += 1) {
    if (round > 400) {
      expect.fail("the diff's steps never finished measuring off screen");
    }
    await settleFrames();
    quietRounds =
      document.querySelector(".meridian-measuring-frames .meridian-diff-block__step") === null
        ? quietRounds + 1
        : 0;
  }
}

/** Scrolls the flow until row `rowIndex` of the first block is drawn, and answers it. */
async function scrollToRow(card: DrawnDiffCard, rowIndex: number): Promise<HTMLElement> {
  const { flow, block } = card;
  const rows = rowsOf(block);
  flow.scrollTop =
    rows.getBoundingClientRect().top -
    flow.getBoundingClientRect().top +
    flow.scrollTop +
    (rows.getBoundingClientRect().height * rowIndex) / rowCountOf(card);
  await settleFrames();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = block.querySelector<HTMLElement>(`[aria-rowindex="${String(rowIndex + 1)}"]`);
    if (row !== null) {
      row.scrollIntoView({ block: "center" });
      await settleFrames();
      return rowAt(block, rowIndex);
    }
    // The window's estimates move as it measures: step toward the row.
    const drawn = [...block.querySelectorAll<HTMLElement>('[role="row"]')];
    const firstPlace = Number(drawn[0]?.getAttribute("aria-rowindex") ?? "0");
    flow.scrollTop += firstPlace > rowIndex + 1 ? -FLOW_HEIGHT_PX : FLOW_HEIGHT_PX;
    await settleFrames();
  }
  return expect.fail(`row ${String(rowIndex)} never drew`);
}

/** Row `rowIndex` of `block`, drawn now. */
function rowAt(block: HTMLElement, rowIndex: number): HTMLElement {
  return (
    block.querySelector<HTMLElement>(`[aria-rowindex="${String(rowIndex + 1)}"]`) ??
    expect.fail(`row ${String(rowIndex)} is not drawn`)
  );
}

/** The block's rows: the table its steps are drawn in. */
function rowsOf(block: HTMLElement): HTMLElement {
  return block.querySelector<HTMLElement>('[role="table"]') ?? expect.fail("the block's rows");
}

/** How many rows the card's first block holds. */
function rowCountOf(card: DrawnDiffCard): number {
  return Number(rowsOf(card.block).getAttribute("aria-rowcount"));
}

/** The transcript row the card is drawn in. */
function rowOf(card: HTMLElement): HTMLElement {
  return (
    card.closest<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`) ??
    expect.fail("the card is drawn in a row")
  );
}

/** The first text node inside `element`. */
function firstTextOf(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return (walker.nextNode() as Text | null) ?? expect.fail("the row holds text");
}

/** The last text node inside `element`. */
function lastTextOf(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    last = node as Text;
  }
  return last ?? expect.fail("the row holds text");
}

/** The first of the card's rows wholly on the flow's screen. */
function firstRowOnScreen(card: HTMLElement, flow: HTMLElement): HTMLElement {
  const screen = flow.getBoundingClientRect();
  const row = [...card.querySelectorAll<HTMLElement>('[role="row"]')].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.top >= screen.top && box.bottom <= screen.bottom;
  });
  return row ?? expect.fail("no row stands on the flow's screen");
}

/** The block's `Show all` control. */
function showAllOf(block: HTMLElement): HTMLButtonElement {
  const showAll = [...block.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Show all",
  );
  return showAll ?? expect.fail("the block drew no Show all");
}
