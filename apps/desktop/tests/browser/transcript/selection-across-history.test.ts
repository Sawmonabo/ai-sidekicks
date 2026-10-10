// A selection in a session whose history lies past the store, in the engine that lays the rows out
// and paints the selection, as the app opens one: on its last page, the rest read back through
// `transcript.read` as the reader scrolls, and let go of by the store as the window lets rows go.
// The reader selects rows on screen and scrolls up until the store lets them go: the system's Copy
// key reads them back and copies the whole selection while the browser's own holds only a caret,
// and back down the browser's selection is the one the reader made. Select All copies the whole
// conversation, its first message to its last, as it does again once the store lets its last rows
// go. A page refused while a copy reads writes nothing and says so.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { COPY, pressKey } from "../../helpers/system-keys.js";
import { FEED_HEIGHT_PX, ROW_SELECTOR, endGesture, mountTranscriptFeed } from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";

import { readSelectedPart } from "#renderer/features/transcript/copy/conversation-selection.js";
import { transcriptOpeningPageLimit } from "#renderer/features/transcript/history/page-limit.js";
import {
  openPagedSessionStore,
  pagedSessionEventAt,
  readRowOf,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
} from "#renderer/features/transcript/logs.test-support.js";
import { projectTranscriptRows } from "#renderer/features/transcript/projection/rows.js";
import { TRANSCRIPT_LET_GO_SCREEN_HEIGHTS } from "#renderer/features/transcript/viewport/caps.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** The session's log, many screens longer than the window keeps. */
const LOG_ROW_COUNT = 300;
/** One wheel gesture, shorter than the drawn band, so every row is drawn on the way up. */
const WHEEL_STEP_PX = 400;
/** Characters into a row's message where an end of the selection is placed. */
const END_OFFSET = 3;
/** Rows in a page cut short; a copy of the let-go rows reads several. */
const CUT_PAGE_LIMIT = 4;
/** What a copy that fails says. */
const COPY_FAILED = "Could not copy";
/** The case scrolls about nine screens one real-time gesture at a time, past the default. */
const CASE_TIMEOUT_MS = 60_000;

/** The person's message at one log position, its text naming the position. */
function messageAt(index: number): ProjectedSessionEvent {
  return { ...pagedSessionEventAt(index), payload: { message: `message_${String(index)}` } };
}

/** The message rows drawn in `scroller`, by log position. */
function drawnRowsIn(scroller: HTMLElement): Map<number, HTMLElement> {
  return new Map(
    [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].flatMap((row) => {
      const match = /message_(\d+)/.exec(row.textContent);
      return match === null ? [] : [[Number(match[1]), row] as const];
    }),
  );
}

/** The text node of a drawn row's message. */
function messageTextOf(row: Element): Text {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, (node) =>
    node.textContent?.startsWith("message_") === true
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_SKIP,
  );
  const text = walker.nextNode();
  return text instanceof Text ? text : expect.fail("a message row draws its message as text");
}

/** What the copy reads out of a drawn row between two points, as it reads any drawn row. */
function drawnPartOf(row: Element, from: "row-start" | Text, to: "row-end" | Text): string {
  const range = document.createRange();
  range.selectNodeContents(row);
  if (from !== "row-start") {
    range.setStart(from, END_OFFSET);
  }
  if (to !== "row-end") {
    range.setEnd(to, END_OFFSET);
  }
  const part = readSelectedPart(range, row, () => expect.fail("a message row draws no table"), {
    drawnText: () => expect.fail("a message row is read at once"),
  });
  return part instanceof Promise ? expect.fail("a message row is read at once") : part.text;
}

describe("a selection the store lets go in a session read from its history", () => {
  it(
    "reads let-go rows back for a copy, writes nothing on a refused page, and comes back the same",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const openingFirstIndex = LOG_ROW_COUNT - transcriptOpeningPageLimit(window);
      const sessionStore = openPagedSessionStore(
        openingFirstIndex,
        LOG_ROW_COUNT - 1,
        { cursor: transcriptFixtureStreamCursor(openingFirstIndex - 1), hasMore: true },
        messageAt,
      );
      const logRows = projectTranscriptRows(
        Array.from({ length: LOG_ROW_COUNT }, (_, index) => messageAt(index)),
      ).rows;
      const history = scriptedTranscriptLog(LOG_ROW_COUNT, (index) =>
        readRowOf(logRows[index] ?? expect.fail(`the log holds row ${String(index)}`)),
      );
      // Pages wait while `heldReads` holds them, for a copy pressed again while one reads. While
      // `cutReads` is set, every page is cut short, as the daemon's frame budget cuts one, and the
      // one it names is refused.
      let heldReads: (() => void)[] | undefined;
      let cutReads: { readonly refusedRead: number; readCount: number } | undefined;
      const { scroller, copied } = await mountTranscriptFeed(sessionStore, async (request) => {
        if (heldReads !== undefined) {
          const waiting = heldReads;
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
          });
        }
        if (cutReads === undefined) {
          return await history.read(request);
        }
        cutReads.readCount += 1;
        if (cutReads.readCount === cutReads.refusedRead) {
          history.refuseNextRead();
        }
        return await history.read({ ...request, limit: CUT_PAGE_LIMIT });
      });
      const drawnRow = (position: number): HTMLElement =>
        drawnRowsIn(scroller).get(position) ?? expect.fail(`row ${String(position)} is drawn`);
      const browserSelection = document.getSelection() ?? expect.fail("the page has a selection");
      const copyNow = async (): Promise<string | undefined> => {
        const before = copied.length;
        await act(() => pressKey(COPY));
        await settleFrames();
        return copied.length === before ? undefined : copied.at(-1)?.text;
      };
      const storedPositions = (): number[] =>
        sessionStore.snapshot().transcript.map((event) => event.sequence);
      const wheel = async (deltaPx: number, steps: number): Promise<void> => {
        for (let step = 0; step < steps; step += 1) {
          await userEvent.wheel(scroller, { delta: { y: deltaPx } });
          await endGesture(scroller);
        }
      };
      const stepsPastLetGo = Math.ceil(
        ((TRANSCRIPT_LET_GO_SCREEN_HEIGHTS + 1) * FEED_HEIGHT_PX) / WHEEL_STEP_PX,
      );

      // At the tail, where the session opens, a selection across four rows on screen.
      const startPosition = LOG_ROW_COUNT - 6;
      const endPosition = LOG_ROW_COUNT - 3;
      const parts = [
        drawnPartOf(drawnRow(startPosition), messageTextOf(drawnRow(startPosition)), "row-end"),
      ];
      for (let position = startPosition + 1; position < endPosition; position += 1) {
        parts.push(drawnPartOf(drawnRow(position), "row-start", "row-end"));
      }
      parts.push(
        drawnPartOf(drawnRow(endPosition), "row-start", messageTextOf(drawnRow(endPosition))),
      );
      const wholeSelection = parts.join("\n\n");
      scroller.focus();
      browserSelection.setBaseAndExtent(
        messageTextOf(drawnRow(startPosition)),
        END_OFFSET,
        messageTextOf(drawnRow(endPosition)),
        END_OFFSET,
      );
      await settleFrames();
      const selectedText = browserSelection.toString();
      expect(await copyNow()).toBe(wholeSelection);

      // Up past the let-go distance, the rows above read back from the history: the window lets
      // the selection's rows go, and the store lets go of their events too.
      await wheel(-WHEEL_STEP_PX, stepsPastLetGo);
      expect([
        drawnRowsIn(scroller).has(startPosition),
        drawnRowsIn(scroller).has(endPosition),
      ]).toStrictEqual([false, false]);
      expect(storedPositions().at(-1)).toBeLessThan(startPosition);
      // No drawn row is in the selection, so the browser's own holds a caret.
      expect(browserSelection.isCollapsed).toBe(true);
      expect(await copyNow()).toBe(wholeSelection);

      // Back down until the rows between the ends are drawn again, the browser's selection is the
      // one the reader made. The end rows stay drawn while the selection stands, so they say
      // nothing of where the reader is.
      for (
        let step = 0;
        step < 4 * stepsPastLetGo && !drawnRowsIn(scroller).has(startPosition + 1);
        step += 1
      ) {
        await wheel(WHEEL_STEP_PX, 1);
      }
      expect(browserSelection.toString()).toBe(selectedText);
      expect(await copyNow()).toBe(wholeSelection);

      // Select All a few screens up copies the whole conversation, its first message to its
      // last, read back past the rows the store holds; far enough up that the store lets the
      // last rows go, the copy holds the same rows.
      await wheel(-WHEEL_STEP_PX, 3);
      await act(() => userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}"));
      await settleFrames();
      const selectedAll = (await copyNow()) ?? expect.fail("Select All copies the conversation");
      expect(
        [...selectedAll.matchAll(/message_(\d+)/g)].map((match) => Number(match[1])),
      ).toStrictEqual(Array.from({ length: LOG_ROW_COUNT }, (_, index) => index));
      await wheel(-WHEEL_STEP_PX, stepsPastLetGo);
      expect(storedPositions().at(-1)).toBeLessThan(LOG_ROW_COUNT - 1);
      expect(await copyNow()).toBe(selectedAll);

      // A page refused while the copy reads, past the first: the clipboard is left as it was, with
      // none of the pages read before it, and the copy says it failed.
      const alert = document.querySelector("[role='alert']") ?? expect.fail("an alert region");
      expect(alert.textContent).not.toContain(COPY_FAILED);
      const copiesBeforeRefusal = copied.length;
      cutReads = { refusedRead: 2, readCount: 0 };
      await act(() => pressKey(COPY));
      await settleFrames();
      expect(cutReads.readCount).toBe(2);
      cutReads = undefined;
      expect(copied.length).toBe(copiesBeforeRefusal);
      expect(alert.textContent).toContain(COPY_FAILED);

      // Copy pressed again while the first copy reads: the newest copy is the one written.
      heldReads = [];
      const pendingReads = heldReads;
      const copiesBeforeTwo = copied.length;
      await act(() => pressKey(COPY));
      const [onScreenPosition] = [...drawnRowsIn(scroller).keys()].slice(-2);
      const onScreenRow = drawnRow(onScreenPosition ?? expect.fail("a row is drawn"));
      browserSelection.setBaseAndExtent(
        messageTextOf(onScreenRow),
        0,
        messageTextOf(onScreenRow),
        messageTextOf(onScreenRow).length,
      );
      await settleFrames();
      await act(() => pressKey(COPY));
      expect(pendingReads.length).toBeGreaterThan(0);
      heldReads = undefined;
      for (const release of pendingReads) {
        release();
      }
      await settleFrames();
      expect(copied.slice(copiesBeforeTwo).map((content) => content.text)).toStrictEqual([
        `message_${String(onScreenPosition)}`,
      ]);
    },
  );
});
