// A reply too large to travel with its row, in a session read from its history, in the engine that
// lays the rows out and paints them. Its row offers the whole body under its size and reads
// nothing until the control is pressed; while the read is out the control says so, a refused read
// offers the press again, and a read that lands draws the body in the control's place. Scrolled
// far enough up that the store lets the row go, and back, the opened body is read again through
// the same client and drawn again. A copy that takes the body in, pressed or not, between its ends
// or at one, reads it in full through the same client and copies it whole, never the control's
// words; a refused read writes nothing and says so. A copy of the rows the store let go reads them
// back and the body with them.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import type { TranscriptBodyReadRequest } from "@ai-sidekicks/contracts/transcript/content";

import { COPY, pressKey } from "../../helpers/system-keys.js";
import { FEED_HEIGHT_PX, ROW_SELECTOR, endGesture, mountTranscriptFeed } from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";

import { transcriptOpeningPageLimit } from "#renderer/features/transcript/history/page-limit.js";
import {
  openPagedSessionStore,
  pagedSessionEventAt,
  readRowOf,
  scriptedTranscriptLog,
  transcriptFixtureEventId,
  transcriptFixtureStreamCursor,
} from "#renderer/features/transcript/logs.test-support.js";
import { projectTranscriptRows } from "#renderer/features/transcript/projection/rows.js";
import { TRANSCRIPT_LET_GO_SCREEN_HEIGHTS } from "#renderer/features/transcript/viewport/caps.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** The session's log, many screens longer than the window keeps. */
const LOG_ROW_COUNT = 300;
/** The reply whose body is too large to travel with it, on screen when the session opens. */
const LARGE_REPLY_INDEX = LOG_ROW_COUNT - 3;
/** One wheel gesture, shorter than the drawn band, so every row is drawn on the way. */
const WHEEL_STEP_PX = 400;
/** The heading the whole body opens with, which only the body read in full holds. */
const BODY_HEADING = "Every lane, in full";
/** The reply's whole body: a heading over many paragraphs. */
const LARGE_BODY = `## ${BODY_HEADING}\n\n${Array.from(
  { length: 400 },
  (_, line) => `Lane ${String(line)} finished in place.`,
).join("\n\n")}`;
/** The whole body's UTF-8 size, as its row carries it. */
const LARGE_BODY_BYTES = new TextEncoder().encode(LARGE_BODY).byteLength;
/** What a copy that fails says. */
const COPY_FAILED = "Could not copy";
/** The case scrolls about nine screens one real-time gesture at a time, past the default. */
const CASE_TIMEOUT_MS = 60_000;

/** The text node of the drawn message row at `index`, its text naming the position. */
function messageTextAt(scroller: HTMLElement, index: number): Text {
  const message = `message_${String(index)}`;
  for (const row of scroller.querySelectorAll(ROW_SELECTOR)) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, (node) =>
      node.textContent === message ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    );
    const text = walker.nextNode();
    if (text instanceof Text) {
      return text;
    }
  }
  return expect.fail(`row ${String(index)} is drawn`);
}

/** A person's message at one log position, or the large reply at its own. */
function eventAt(index: number): ProjectedSessionEvent {
  const event = pagedSessionEventAt(index);
  return index === LARGE_REPLY_INDEX
    ? {
        ...event,
        kind: "assistant.message",
        payload: { contentType: "text/markdown" },
        content: { status: "large", contentLength: LARGE_BODY_BYTES },
      }
    : { ...event, payload: { message: `message_${String(index)}` } };
}

describe("a reply whose body is too large to travel with its row", () => {
  it(
    "reads its body only when pressed, says how the read stands, and reads it again once let go",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const openingFirstIndex = LOG_ROW_COUNT - transcriptOpeningPageLimit(window);
      const sessionStore = openPagedSessionStore(
        openingFirstIndex,
        LOG_ROW_COUNT - 1,
        { cursor: transcriptFixtureStreamCursor(openingFirstIndex - 1), hasMore: true },
        eventAt,
      );
      const logRows = projectTranscriptRows(
        Array.from({ length: LOG_ROW_COUNT }, (_, index) => eventAt(index)),
      ).rows;
      const history = scriptedTranscriptLog(LOG_ROW_COUNT, (index) =>
        readRowOf(logRows[index] ?? expect.fail(`the log holds row ${String(index)}`)),
      );
      // Each body read waits until the case answers it: served with the body, or refused.
      const bodyReads: TranscriptBodyReadRequest[] = [];
      const waitingReads: ((isServed: boolean) => void)[] = [];
      const readBody: TranscriptBodyRead = (request) => {
        bodyReads.push(request);
        return new Promise((resolve) => {
          waitingReads.push((isServed) => {
            resolve(
              isServed
                ? { status: "served", value: { status: "available", body: LARGE_BODY } }
                : {
                    status: "refused",
                    refusal: { code: "unscripted", detail: "No body there.", origin: "test" },
                  },
            );
          });
        });
      };
      const answerRead = async (isServed: boolean): Promise<void> => {
        await act(async () => {
          (waitingReads.shift() ?? expect.fail("a body read is waiting"))(isServed);
          await Promise.resolve();
        });
        await settleFrames();
      };
      const { scroller, copied } = await mountTranscriptFeed(
        sessionStore,
        history.read,
        undefined,
        readBody,
      );
      const control = (): HTMLButtonElement | null =>
        scroller.querySelector<HTMLButtonElement>(".meridian-full-output");
      const pressControl = async (): Promise<void> => {
        await act(async () => {
          (control() ?? expect.fail("the reply offers its full output")).click();
          await Promise.resolve();
        });
        await settleFrames();
      };
      // Drawn as markdown: the heading is a heading, never its source.
      const drawsWholeBody = (): boolean =>
        [...scroller.querySelectorAll("[role='heading']")].some((heading) =>
          heading.textContent.includes(BODY_HEADING),
        ) && !scroller.textContent.includes(`## ${BODY_HEADING}`);
      const wheel = async (deltaPx: number, steps: number): Promise<void> => {
        for (let step = 0; step < steps; step += 1) {
          await userEvent.wheel(scroller, { delta: { y: deltaPx } });
          await endGesture();
        }
      };
      const stepsPastLetGo = Math.ceil(
        ((TRANSCRIPT_LET_GO_SCREEN_HEIGHTS + 1) * FEED_HEIGHT_PX) / WHEEL_STEP_PX,
      );
      const isReplyStored = (): boolean =>
        sessionStore
          .snapshot()
          .transcript.some((event) => event.id === transcriptFixtureEventId(LARGE_REPLY_INDEX));
      // Down a gesture at a time until the reply's control is drawn again.
      const scrollBackToControl = async (): Promise<void> => {
        for (let step = 0; step < 4 * stepsPastLetGo && control() === null; step += 1) {
          await wheel(WHEEL_STEP_PX, 1);
        }
      };
      const browserSelection = document.getSelection() ?? expect.fail("the page has a selection");
      // From the start of the node `from` to the end of the message row after the large reply.
      const selectThroughReply = async (from: Text): Promise<void> => {
        const end = messageTextAt(scroller, LARGE_REPLY_INDEX + 1);
        scroller.focus();
        browserSelection.setBaseAndExtent(from, 0, end, end.length);
        await settleFrames();
      };
      // The copy key pressed, and the body read it asks for answered: what reached the clipboard.
      const copyAnswering = async (isServed: boolean): Promise<string | undefined> => {
        const before = copied.length;
        await act(() => pressKey(COPY));
        await answerRead(isServed);
        return copied.length === before ? undefined : copied.at(-1)?.text;
      };
      const largeReplyRead = {
        sessionId: sessionStore.sessionId,
        rowId: transcriptFixtureEventId(LARGE_REPLY_INDEX),
      };
      const replyCopied = `${LARGE_BODY}\n\nmessage_${String(LARGE_REPLY_INDEX + 1)}`;
      const throughReplyCopied = `message_${String(LARGE_REPLY_INDEX - 1)}\n\n${replyCopied}`;

      // Drawn with its size and nothing read, scrolled past or not.
      expect(control()?.textContent).toBe(
        `Show full output (${formatByteQuantity(LARGE_BODY_BYTES).text})`,
      );
      await wheel(-WHEEL_STEP_PX, 2);
      await wheel(WHEEL_STEP_PX, 4);
      expect(bodyReads).toStrictEqual([]);

      // Copied unpressed, across it and from inside it, the body is read in full and copied whole,
      // and the row still offers it under its size.
      await selectThroughReply(messageTextAt(scroller, LARGE_REPLY_INDEX - 1));
      expect(await copyAnswering(true)).toBe(throughReplyCopied);
      const controlText = control()?.firstChild ?? expect.fail("the control draws its words");
      await selectThroughReply(controlText instanceof Text ? controlText : expect.fail("as text"));
      expect(await copyAnswering(true)).toBe(replyCopied);
      // Copied as the markdown it is, with its formatted flavor beside it.
      expect(copied.at(-1)?.html).toContain(`>${BODY_HEADING}</h2>`);
      expect(bodyReads).toStrictEqual([largeReplyRead, largeReplyRead]);
      expect(control()?.textContent).toBe(
        `Show full output (${formatByteQuantity(LARGE_BODY_BYTES).text})`,
      );
      expect(drawsWholeBody()).toBe(false);

      // A refused read writes nothing and says the copy failed.
      const alert = document.querySelector("[role='alert']") ?? expect.fail("an alert region");
      expect(alert.textContent).not.toContain(COPY_FAILED);
      expect(await copyAnswering(false)).toBe(undefined);
      expect(alert.textContent).toContain(COPY_FAILED);

      // Selected across it, then up until the store lets it go: the copy reads the rows back, and
      // the body in full through the same client.
      await selectThroughReply(messageTextAt(scroller, LARGE_REPLY_INDEX - 1));
      await wheel(-WHEEL_STEP_PX, stepsPastLetGo);
      expect(isReplyStored()).toBe(false);
      expect(await copyAnswering(true)).toBe(throughReplyCopied);
      expect(bodyReads).toHaveLength(4);
      browserSelection.removeAllRanges();
      await scrollBackToControl();
      const copyReadCount = bodyReads.length;

      // Pressed: one read of the row, and the control says it is out until it is refused.
      await pressControl();
      expect(bodyReads.slice(copyReadCount)).toStrictEqual([largeReplyRead]);
      expect(control()?.textContent).toBe("Loading the full output…");
      await answerRead(false);
      expect(control()?.textContent).toBe("Couldn't load the full output · Retry");
      expect(drawsWholeBody()).toBe(false);

      // Pressed again, the read lands and the body takes the control's place.
      await pressControl();
      expect(bodyReads).toHaveLength(copyReadCount + 2);
      await answerRead(true);
      expect(control()).toBe(null);
      expect(drawsWholeBody()).toBe(true);

      // Up until the store lets the reply go, then back: its row is drawn again with its size
      // alone, and the opened body is read again and drawn again.
      await wheel(-WHEEL_STEP_PX, stepsPastLetGo);
      expect(isReplyStored()).toBe(false);
      expect(drawsWholeBody()).toBe(false);
      await scrollBackToControl();
      expect(control()?.textContent).toBe("Loading the full output…");
      expect(bodyReads).toHaveLength(copyReadCount + 3);
      await answerRead(true);
      expect(control()).toBe(null);
      expect(drawsWholeBody()).toBe(true);
    },
  );
});
