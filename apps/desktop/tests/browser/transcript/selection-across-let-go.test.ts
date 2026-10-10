// A selection that runs across more of a long log than the window keeps, in the engine that lays
// the rows out and paints the selection. The reader selects from a row near the head and drags it
// down several screens; the row the selection starts in stays drawn and the browser's selection
// anchored while it sits within the let-go distance, and past it the row goes, the browser's
// selection covers just the drawn rows the viewport's record covers, and the system's Copy key
// copies the whole selection. Scrolling back, every frame shows the record's drawn rows selected
// and no other. A click clears it the way it clears the browser's own. Select All in the log
// selects the whole log, and a drag across the transcript copies the page's text around it and
// every row of the log within.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import type { TextClipboardContent } from "#shared/preload-api.js";
import {
  COMPOSER_TEXT,
  FEED_HEIGHT_PX,
  ROW_SELECTOR,
  SESSION_HEADER_TEXT,
  TOOL_ROW_COUNT,
  endGesture,
  mountLongToolFeed,
  positionOfRow,
} from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";
import { COPY, pressKey } from "../../helpers/system-keys.js";

import { readSelectedPart } from "#renderer/features/transcript/copy/conversation-selection.js";
import { TRANSCRIPT_LET_GO_SCREEN_HEIGHTS } from "#renderer/features/transcript/viewport/caps.js";
import { transcriptWindowDiagnostics } from "#renderer/lib/transcript-window-diagnostics.js";

/** One wheel gesture, shorter than the drawn band, so every row is drawn on the way down. */
const WHEEL_STEP_PX = 400;
/** The log position of the row the selection starts in, near the head. */
const START_ROW_POSITION = 2;
/** Characters into a row's tool name where an end of the selection is placed. */
const END_OFFSET_IN_NAME = 3;
/** The case scrolls about twenty screens one real-time gesture at a time, past the default. */
const CASE_TIMEOUT_MS = 60_000;

/** A drawn tool row's name. */
function nameOf(row: Element): Element {
  return row.querySelector(".meridian-tool-card__name") ?? expect.fail("a tool row draws its name");
}

/** The text node of a row's tool name. */
function nameTextOf(row: Element): Text {
  const text = nameOf(row).firstChild;
  return text instanceof Text ? text : expect.fail("a tool row draws its name as text");
}

/** What the copy reads out of a drawn row between two points, as it reads any drawn row. */
function drawnPartOf(row: Element, from: "row-start" | Text, to: "row-end" | Text): string {
  const range = document.createRange();
  range.selectNodeContents(row);
  if (from !== "row-start") {
    range.setStart(from, END_OFFSET_IN_NAME);
  }
  if (to !== "row-end") {
    range.setEnd(to, END_OFFSET_IN_NAME);
  }
  return readSelectedPart(range, row, () => expect.fail("a tool row draws no table")).text;
}

describe("a selection across more of the log than the window keeps", () => {
  it(
    "stays anchored within the let-go distance, copies whole past it, and clears on a click",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { scroller, copied, sessionId } = await mountLongToolFeed();
      const drawnRows = (): Map<number, HTMLElement> =>
        new Map(
          [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].flatMap((row) => {
            const position = positionOfRow(row);
            return position === undefined ? [] : [[position, row] as const];
          }),
        );
      const drawnRow = (position: number): HTMLElement =>
        drawnRows().get(position) ?? expect.fail(`row ${String(position)} is drawn`);
      const browserSelection = document.getSelection() ?? expect.fail("the page has a selection");

      // Each row's whole text as the copy reads it while it is drawn: the oracle for the rows the
      // window lets go before the copy.
      const wholeRowText = new Map<number, string>();
      const noteDrawnRows = (): void => {
        for (const [position, row] of drawnRows()) {
          if (!wholeRowText.has(position)) {
            wholeRowText.set(position, drawnPartOf(row, "row-start", "row-end"));
          }
        }
      };

      scroller.focus();
      await act(() => userEvent.keyboard("{Home}"));
      await endGesture();
      noteDrawnRows();
      const startRow = drawnRow(START_ROW_POSITION);
      const startText = nameTextOf(startRow);
      const startPart = drawnPartOf(startRow, startText, "row-end");
      let endPosition = START_ROW_POSITION + 3;
      let endPart = drawnPartOf(
        drawnRow(endPosition),
        "row-start",
        nameTextOf(drawnRow(endPosition)),
      );
      browserSelection.setBaseAndExtent(
        startText,
        END_OFFSET_IN_NAME,
        nameTextOf(drawnRow(endPosition)),
        END_OFFSET_IN_NAME,
      );

      /**
       * Drags the selection's end to the last row whole on screen, as a drag past the edge does.
       */
      const dragEndToScreenBottom = (): void => {
        const scrollerBottom = scroller.getBoundingClientRect().bottom;
        const lastOnScreen = Math.max(
          ...[...drawnRows()]
            .filter(([, row]) => row.getBoundingClientRect().bottom <= scrollerBottom)
            .map(([position]) => position),
        );
        endPosition = lastOnScreen;
        const endRow = drawnRow(endPosition);
        endPart = drawnPartOf(endRow, "row-start", nameTextOf(endRow));
        browserSelection.extend(nameTextOf(endRow), END_OFFSET_IN_NAME);
      };
      /** What a copy of the whole selection holds: the end rows' parts, every row between whole. */
      const wholeSelectionText = (): string => {
        const parts = [startPart];
        for (let position = START_ROW_POSITION + 1; position < endPosition; position += 1) {
          parts.push(
            wholeRowText.get(position) ?? expect.fail(`row ${String(position)} was drawn`),
          );
        }
        parts.push(endPart);
        return parts.filter((part) => part.trim() !== "").join("\n\n");
      };
      const copyNow = async (): Promise<TextClipboardContent | undefined> => {
        const before = copied.length;
        await act(() => pressKey(COPY));
        await settleFrames();
        return copied.length === before ? undefined : copied.at(-1);
      };

      // Down about seven screens, the selection's end following the screen's bottom.
      const screensBeforeLetGo = TRANSCRIPT_LET_GO_SCREEN_HEIGHTS - 1;
      const stepsBeforeLetGo = Math.ceil((screensBeforeLetGo * FEED_HEIGHT_PX) / WHEEL_STEP_PX);
      for (let step = 0; step < stepsBeforeLetGo; step += 1) {
        await userEvent.wheel(scroller, { delta: { y: WHEEL_STEP_PX } });
        await endGesture();
        noteDrawnRows();
        dragEndToScreenBottom();
        await settleFrames();
      }

      // Within the let-go distance: the start row is beyond the drawn band but still drawn, and the
      // browser's selection is the reader's, anchored in it.
      const scrollerTop = scroller.getBoundingClientRect().top;
      const heldStartRow = drawnRow(START_ROW_POSITION);
      expect(heldStartRow.getBoundingClientRect().bottom).toBeLessThan(
        scrollerTop - scroller.clientHeight,
      );
      expect(browserSelection.isCollapsed).toBe(false);
      expect(heldStartRow.contains(browserSelection.getRangeAt(0).startContainer)).toBe(true);
      expect((await copyNow())?.text).toBe(wholeSelectionText());

      /** The drawn rows the browser's selection covers wrongly: in the record and not, or out. */
      const wronglyCoveredRows = (): number[] => {
        const range =
          browserSelection.rangeCount === 0 ? undefined : browserSelection.getRangeAt(0);
        return [...drawnRows()].flatMap(([position, row]) => {
          const isInRecord = position >= START_ROW_POSITION && position <= endPosition;
          return (range?.intersectsNode(row) ?? false) === isInRecord ? [] : [position];
        });
      };

      // Past the let-go distance: the start row goes like any row, the browser's selection covers
      // the drawn rows the record covers, and the record copies.
      const stepsPastLetGo = Math.ceil(FEED_HEIGHT_PX / WHEEL_STEP_PX);
      for (let step = 0; step < stepsPastLetGo; step += 1) {
        await userEvent.wheel(scroller, { delta: { y: WHEEL_STEP_PX } });
        await endGesture();
      }
      expect(drawnRows().has(START_ROW_POSITION)).toBe(false);
      expect(browserSelection.isCollapsed).toBe(false);
      expect(wronglyCoveredRows()).toStrictEqual([]);
      expect((await copyNow())?.text).toBe(wholeSelectionText());

      // Back up until the start row is drawn again, each frame read as it is painted: the rows
      // coming back into the record show selected the frame they appear, and the start is written
      // where it sits once its row is drawn.
      const wrongFrames: number[][] = [];
      let isSampling = true;
      const sampleFrame = (): void => {
        const wrong = wronglyCoveredRows();
        if (wrong.length > 0) {
          wrongFrames.push(wrong);
        }
        if (isSampling) {
          requestAnimationFrame(sampleFrame);
        }
      };
      requestAnimationFrame(sampleFrame);
      for (
        let step = 0;
        step < stepsBeforeLetGo + stepsPastLetGo && !drawnRows().has(START_ROW_POSITION);
        step += 1
      ) {
        await userEvent.wheel(scroller, { delta: { y: -WHEEL_STEP_PX } });
        await endGesture();
      }
      isSampling = false;
      expect(wrongFrames).toStrictEqual([]);
      expect(
        drawnRow(START_ROW_POSITION).contains(browserSelection.getRangeAt(0).startContainer),
      ).toBe(true);
      expect((await copyNow())?.text).toBe(wholeSelectionText());

      // At the tail, both end rows let go: the copy is still whole and the window still bounded.
      await act(() => userEvent.keyboard("{End}"));
      await endGesture();
      noteDrawnRows();
      expect(drawnRows().has(endPosition)).toBe(false);
      expect((await copyNow())?.text).toBe(wholeSelectionText());
      const reading =
        transcriptWindowDiagnostics.readingFor(sessionId) ?? expect.fail("the feed registered");
      const windowRowBound = (TRANSCRIPT_LET_GO_SCREEN_HEIGHTS + 1) * reading.visibleRowCount;
      expect(reading.totalRowCount).toBeLessThanOrEqual(windowRowBound);

      // A click on a row's text clears the record, as it clears the browser's own selection.
      const [, clickedRow] = [...drawnRows()].at(-1) ?? expect.fail("the tail is drawn");
      await act(() => userEvent.click(nameOf(clickedRow)));
      await settleFrames();
      expect(browserSelection.isCollapsed).toBe(true);
      expect(await copyNow()).toBeUndefined();

      /** Select All, then a copy of every row from the head's text to the tail's, then a click. */
      const selectAllThenClear = async (selectAll: () => Promise<void>): Promise<void> => {
        await selectAll();
        await settleFrames();
        const parts = (await copyNow())?.text.split("\n\n") ?? [];
        expect(parts.map((part) => /\btool_(\d+)\b/.exec(part)?.[1])).toStrictEqual(
          Array.from({ length: TOOL_ROW_COUNT }, (_, position) => String(position)),
        );
        expect(parts[0]).toBe(wholeRowText.get(0));
        expect(parts.at(-1)).toBe(wholeRowText.get(TOOL_ROW_COUNT - 1));
        // Every drawn row shows selected, the browser's selection clamped to them.
        const selectedRange = browserSelection.getRangeAt(0);
        expect([...drawnRows().values()].every((row) => selectedRange.intersectsNode(row))).toBe(
          true,
        );
        expect(
          transcriptWindowDiagnostics.readingFor(sessionId)?.totalRowCount,
        ).toBeLessThanOrEqual(windowRowBound);
        await act(() => userEvent.click(nameOf(drawnRow(START_ROW_POSITION))));
        await settleFrames();
        expect(browserSelection.isCollapsed).toBe(true);
        expect(await copyNow()).toBeUndefined();
      };
      // At the head, where the browser's own Select All would end in the last row drawn.
      await act(() => userEvent.keyboard("{Home}"));
      await endGesture();
      await selectAllThenClear(() =>
        act(() => userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}")),
      );
      // From a control inside a row, the press the log does not take, as the Edit menu's command
      // reaches it: the browser's own Select All starts and the log takes it over.
      await selectAllThenClear(async () => {
        (
          drawnRow(0).querySelector("button") ?? expect.fail("a tool row draws its disclosure")
        ).focus();
        await act(() => userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}"));
      });

      // A drag from the session header above the transcript to the composer below it, across rows
      // the window let go: every row of the log, in order, and none of the page's text around it.
      expect(drawnRows().has(TOOL_ROW_COUNT - 1)).toBe(false);
      const headerText = document.querySelector("[data-testid='session-header']")?.firstChild;
      const composerText = document.querySelector("[data-testid='composer']")?.firstChild;
      if (!(headerText instanceof Text) || !(composerText instanceof Text)) {
        throw new Error("the page draws its header and composer as text");
      }
      browserSelection.setBaseAndExtent(headerText, 0, composerText, composerText.length);
      await settleFrames();
      const crossing = (await copyNow())?.text ?? expect.fail("the crossing selection is copied");
      expect(crossing.startsWith(wholeRowText.get(0) ?? "")).toBe(true);
      expect(crossing.endsWith(wholeRowText.get(TOOL_ROW_COUNT - 1) ?? "")).toBe(true);
      expect([
        crossing.includes(SESSION_HEADER_TEXT),
        crossing.includes(COMPOSER_TEXT),
      ]).toStrictEqual([false, false]);
      expect([...crossing.matchAll(/\btool_(\d+)\b/g)].map((match) => match[1])).toStrictEqual(
        Array.from({ length: TOOL_ROW_COUNT }, (_, position) => String(position)),
      );

      // Across the transcript's end: a drag from a row to the composer, then far enough down that
      // the row is let go. The composer stays selected where the reader's drag ended, and the copy
      // takes the rows from that row on, and still no page text.
      await act(() => userEvent.keyboard("{Home}"));
      await endGesture();
      const anchoredPosition = START_ROW_POSITION + 3;
      browserSelection.setBaseAndExtent(
        nameTextOf(drawnRow(anchoredPosition)),
        END_OFFSET_IN_NAME,
        composerText,
        composerText.length,
      );
      await settleFrames();
      const stepsBeyondLetGo = Math.ceil(
        ((TRANSCRIPT_LET_GO_SCREEN_HEIGHTS + 1) * FEED_HEIGHT_PX) / WHEEL_STEP_PX,
      );
      for (let step = 0; step < stepsBeyondLetGo; step += 1) {
        await userEvent.wheel(scroller, { delta: { y: WHEEL_STEP_PX } });
        await endGesture();
      }
      expect(drawnRows().has(anchoredPosition)).toBe(false);
      const acrossEnd = browserSelection.getRangeAt(0);
      expect([acrossEnd.endContainer, acrossEnd.endOffset]).toStrictEqual([
        composerText,
        composerText.length,
      ]);
      const copiedAcrossEnd =
        (await copyNow())?.text ?? expect.fail("the selection across the end is copied");
      expect(copiedAcrossEnd.startsWith(`l_${String(anchoredPosition)} `)).toBe(true);
      expect(copiedAcrossEnd.endsWith(wholeRowText.get(TOOL_ROW_COUNT - 1) ?? "")).toBe(true);
      expect(copiedAcrossEnd.includes(COMPOSER_TEXT)).toBe(false);
      expect(
        [...copiedAcrossEnd.matchAll(/\btool_(\d+)\b/g)].map((match) => match[1]),
      ).toStrictEqual(
        Array.from({ length: TOOL_ROW_COUNT - anchoredPosition - 1 }, (_, index) =>
          String(anchoredPosition + 1 + index),
        ),
      );
    },
  );
});
