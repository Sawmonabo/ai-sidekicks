// A call's output opened whole in the real feed: `Show all` draws it whole where its box stands,
// and it stays whole when its row is scrolled out of the drawn band and back, and when the call is
// folded and opened again. A large output read in full by its control's press draws whole once the
// read lands, with no second press.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import { ROW_SELECTOR, endGesture, mountTranscriptFeed } from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";

import {
  PAGED_SESSION_ID,
  openPagedSessionStore,
  pagedSessionEventAt,
} from "#renderer/features/transcript/logs.test-support.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** The session's log, a few screens of messages over the two calls near its tail. */
const LOG_ROW_COUNT = 120;
/** The call whose output is held whole with its row, cut at the flow until opened. */
const HELD_CALL_INDEX = LOG_ROW_COUNT - 4;
/** The call whose output is too large to travel with its row. */
const LARGE_CALL_INDEX = LOG_ROW_COUNT - 2;
const HELD_TOOL_NAME = "held_output";
const LARGE_TOOL_NAME = "large_output";
/** Many more lines than a quarter of the flow holds. */
const PRINTED_LINE_COUNT = 120;
/** One wheel gesture, shorter than the drawn band, so every row is drawn on the way. */
const WHEEL_STEP_PX = 400;
/** More gestures than it takes the held call to leave the drawn band, or to come back. */
const MAX_WHEEL_STEPS = 30;
/** The case scrolls a few screens one real-time gesture at a time, past the default. */
const CASE_TIMEOUT_MS = 30_000;

const PRINTED_OUTPUT = Array.from(
  { length: PRINTED_LINE_COUNT },
  (_line, index) => `line ${String(index + 1)}`,
).join("\n");

/** A message at one log position, or one of the two calls at theirs. */
function eventAt(index: number): ProjectedSessionEvent {
  const event = pagedSessionEventAt(index);
  if (index !== HELD_CALL_INDEX && index !== LARGE_CALL_INDEX) {
    return { ...event, payload: { message: `message_${String(index)}` } };
  }
  const isLarge = index === LARGE_CALL_INDEX;
  const contentLength = new TextEncoder().encode(PRINTED_OUTPUT).byteLength;
  return {
    ...event,
    kind: "tool.result",
    payload: {
      sessionId: PAGED_SESSION_ID,
      toolName: isLarge ? LARGE_TOOL_NAME : HELD_TOOL_NAME,
      toolCallId: `call-${String(index)}`,
      [CONTENT_LENGTH_PAYLOAD_KEY]: contentLength,
    },
    content: isLarge
      ? { status: "large", contentLength }
      : { status: "available", body: PRINTED_OUTPUT },
  };
}

/** The drawn row of the call named `toolName`, or `undefined` while it is out of the drawn band. */
function callRowOf(scroller: HTMLElement, toolName: string): HTMLElement | undefined {
  return [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)].find(
    (row) => row.querySelector(".meridian-tool-card__name")?.textContent === toolName,
  );
}

/** Whether the call's output is drawn whole: its box uncut and no `Show all` under it. */
function isDrawnWhole(row: HTMLElement): boolean {
  const box =
    row.querySelector(".meridian-machine-body__plain") ?? expect.fail("the call draws its output");
  return (
    !box.classList.contains("meridian-output-cut__body--cut") &&
    box.textContent.includes(`line ${String(PRINTED_LINE_COUNT)}`) &&
    row.querySelector(".meridian-full-output") === null
  );
}

async function press(control: HTMLElement): Promise<void> {
  await act(async () => {
    control.click();
    await Promise.resolve();
  });
  await settleFrames();
}

describe("a call's output opened whole", () => {
  it(
    "stays whole through its row leaving the drawn band and a fold, and a large one needs one press",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const sessionStore = openPagedSessionStore(0, LOG_ROW_COUNT - 1, undefined, eventAt);
      const waitingReads: (() => void)[] = [];
      const readBody: TranscriptBodyRead = () =>
        new Promise((resolve) => {
          waitingReads.push(() => {
            resolve({ status: "served", value: { status: "available", body: PRINTED_OUTPUT } });
          });
        });
      const { scroller } = await mountTranscriptFeed(sessionStore, undefined, undefined, readBody);
      const heldRow = (): HTMLElement | undefined => callRowOf(scroller, HELD_TOOL_NAME);
      const drawnHeldRow = (): HTMLElement => heldRow() ?? expect.fail("the held call is drawn");
      const wheelUntil = async (deltaPx: number, isDone: () => boolean): Promise<void> => {
        for (let step = 0; step < MAX_WHEEL_STEPS && !isDone(); step += 1) {
          await userEvent.wheel(scroller, { delta: { y: deltaPx } });
          await endGesture(scroller);
        }
      };

      // Cut at the flow, and `Show all` draws it whole where its box stands.
      const showAll =
        [...drawnHeldRow().querySelectorAll<HTMLElement>("button")].find(
          (button) => button.textContent === "Show all",
        ) ?? expect.fail("the held call offers Show all");
      const box = (): HTMLElement =>
        drawnHeldRow().querySelector<HTMLElement>(".meridian-machine-body__plain") ??
        expect.fail("the held call draws its output");
      const boxTopBeforePx = box().getBoundingClientRect().top;
      await press(showAll);
      expect(isDrawnWhole(drawnHeldRow())).toBe(true);
      expect(box().getBoundingClientRect().top).toBeCloseTo(boxTopBeforePx, 0);

      // Out of the drawn band and back, it is drawn whole again.
      await wheelUntil(-WHEEL_STEP_PX, () => heldRow() === undefined);
      expect(heldRow()).toBe(undefined);
      await wheelUntil(WHEEL_STEP_PX, () => heldRow() !== undefined);
      expect(isDrawnWhole(drawnHeldRow())).toBe(true);

      // Folded and opened again, it is drawn whole again.
      const chevron = (): HTMLElement =>
        drawnHeldRow().querySelector<HTMLElement>(".meridian-tool-card__disclosure") ??
        expect.fail("the held call draws its chevron");
      await press(chevron());
      expect(drawnHeldRow().querySelector(".meridian-machine-body__plain")).toBe(null);
      await press(chevron());
      expect(isDrawnWhole(drawnHeldRow())).toBe(true);

      // A large output: one press reads it, and it lands whole.
      await wheelUntil(WHEEL_STEP_PX, () => callRowOf(scroller, LARGE_TOOL_NAME) !== undefined);
      const largeRow = (): HTMLElement =>
        callRowOf(scroller, LARGE_TOOL_NAME) ?? expect.fail("the large call is drawn");
      await press(
        largeRow().querySelector<HTMLElement>(".meridian-full-output") ??
          expect.fail("the large call offers its full output"),
      );
      await act(async () => {
        (waitingReads.shift() ?? expect.fail("a body read is waiting"))();
        await Promise.resolve();
      });
      await settleFrames();
      expect(isDrawnWhole(largeRow())).toBe(true);
    },
  );
});
