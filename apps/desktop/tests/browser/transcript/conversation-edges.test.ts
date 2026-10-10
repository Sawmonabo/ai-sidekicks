// The ends of a conversation whose history lies past the store, as the app opens one on its last
// page: Home reads the conversation's first page in place of the window and lands on its first
// message, End reads the newest page back and follows the stream again, a jump whose read is
// refused moves nothing, and a selection dragged past the loaded rows reaches the conversation's
// first message, so its copy holds every message from there.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { COPY, pressKey } from "../../helpers/system-keys.js";
import { ROW_SELECTOR, mountTranscriptFeed } from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";

import { transcriptOpeningPageLimit } from "#renderer/features/transcript/history/page-limit.js";
import {
  openPagedSessionStore,
  pagedSessionEventAt,
  readRowOf,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
} from "#renderer/features/transcript/logs.test-support.js";
import { projectTranscriptRows } from "#renderer/features/transcript/projection/rows.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** The session's log, many screens longer than the window keeps. */
const LOG_ROW_COUNT = 300;
/** Characters into a row's message where the selection's end is placed. */
const END_OFFSET = 3;

/** The person's message at one log position, its text naming the position. */
function messageAt(index: number): ProjectedSessionEvent {
  return { ...pagedSessionEventAt(index), payload: { message: `message_${String(index)}` } };
}

/** The log positions of the message rows drawn in `scroller`, in drawn order. */
function drawnPositionsIn(scroller: HTMLElement): number[] {
  return [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].flatMap((row) => {
    const match = /message_(\d+)/.exec(row.textContent);
    return match === null ? [] : [Number(match[1])];
  });
}

/** The log position of the first message row whose top shows in `scroller`. */
function topShownPosition(scroller: HTMLElement): number | undefined {
  const scrollerTopPx = scroller.getBoundingClientRect().top;
  const shown = [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].find(
    (row) => row.getBoundingClientRect().bottom > scrollerTopPx + 1,
  );
  const match = shown === undefined ? null : /message_(\d+)/.exec(shown.textContent);
  return match === null ? undefined : Number(match[1]);
}

describe("the ends of a conversation read from its history", () => {
  it(
    "lands Home and End on its ends, moves nothing on a refused read, and selects past the rows",
    { timeout: 60_000 },
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
      const { scroller, copied } = await mountTranscriptFeed(sessionStore, history.read);
      const press = async (key: string): Promise<void> => {
        scroller.focus();
        await act(() => userEvent.keyboard(key));
        await settleFrames();
      };

      // Home reads the first page in place of the window and lands on the first message.
      await press("{Home}");
      await expect.poll(() => topShownPosition(scroller)).toBe(0);
      expect(sessionStore.snapshot().transcriptHead.hasMore).toBe(false);
      expect(sessionStore.snapshot().transcript[0]?.sequence).toBe(0);

      // End reads the newest page back in place of it, follows the stream and shows the last.
      await press("{End}");
      await expect.poll(() => drawnPositionsIn(scroller).at(-1)).toBe(LOG_ROW_COUNT - 1);
      expect(sessionStore.snapshot().transcriptTail.following).toBe("live");
      expect(sessionStore.snapshot().transcript[0]?.sequence).toBeGreaterThan(0);

      // Home again, its read refused: the reader stays where they are.
      const shownBeforeRefusal = topShownPosition(scroller);
      const scrollTopBeforeRefusal = scroller.scrollTop;
      const readsBeforeRefusal = history.requests.length;
      history.refuseNextRead();
      await press("{Home}");
      await expect.poll(() => history.requests.length).toBe(readsBeforeRefusal + 1);
      await settleFrames();
      expect([topShownPosition(scroller), scroller.scrollTop]).toStrictEqual([
        shownBeforeRefusal,
        scrollTopBeforeRefusal,
      ]);
      expect(sessionStore.snapshot().transcriptHead.hasMore).toBe(true);

      // A selection from a row on screen dragged up past the transcript, onto the page above it,
      // reaches the conversation's first message: its copy holds every message from there.
      const endPosition = drawnPositionsIn(scroller).at(-3) ?? expect.fail("rows are drawn");
      const endRow =
        [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].find((row) =>
          row.textContent.includes(`message_${String(endPosition)}`),
        ) ?? expect.fail("the end row is drawn");
      const endText =
        document
          .createTreeWalker(endRow, NodeFilter.SHOW_TEXT, (node) =>
            node.textContent?.startsWith("message_") === true
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP,
          )
          .nextNode() ?? expect.fail("the end row draws its message as text");
      const header =
        document.querySelector("[data-testid='session-header']")?.firstChild ??
        expect.fail("the page draws its header");
      document.getSelection()?.setBaseAndExtent(endText, END_OFFSET, header, 0);
      await settleFrames();
      const copiesBefore = copied.length;
      await act(() => pressKey(COPY));
      await expect.poll(() => copied.length).toBe(copiesBefore + 1);
      const copiedText = copied.at(-1)?.text ?? expect.fail("the copy holds text");
      expect(
        [...copiedText.matchAll(/message_(\d+)/g)].map((match) => Number(match[1])),
      ).toStrictEqual(Array.from({ length: endPosition }, (_, index) => index));
      expect(copiedText.endsWith(`\n\n${"message_".slice(0, END_OFFSET)}`)).toBe(true);
    },
  );
});
