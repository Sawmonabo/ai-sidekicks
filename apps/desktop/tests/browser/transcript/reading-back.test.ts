// Reading back toward the head of a log longer than the window keeps, in the engine that lays the
// rows out, as the app opens a session: at its tail, the rest served as history. Each wheel turn
// toward the head moves every row on screen by exactly the turn, on every frame and every change
// to the list, while pages join at the window's head and rows go at its tail: the scroll offset
// jumps by the height that joined, and the reader sees none of it.

import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import {
  FEED_HEIGHT_PX,
  ROW_SELECTOR,
  endGesture,
  mountLongToolHistory,
  positionOfRow,
} from "./long-tool-feed.js";

/** Screens the reader wheels each way: far enough that the window lets its head go. */
const SCREEN_COUNT = 15;
/** The case scrolls forty-five screens one real-time gesture at a time, past the default. */
const CASE_TIMEOUT_MS = 60_000;

/** Where each drawn row inside the box stands below the box's top, by log position. */
function rowTopsOnScreen(scroller: HTMLElement): Map<number, number> {
  const box = scroller.getBoundingClientRect();
  const tops = new Map<number, number>();
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const position = positionOfRow(row);
    const rect = row.getBoundingClientRect();
    if (position !== undefined && rect.bottom > box.top && rect.top < box.bottom) {
      tops.set(position, rect.top - box.top);
    }
  }
  return tops;
}

/** Whether two distances agree to the scroll offset's grain, a device pixel. */
function isWithinGrain(distancePx: number, expectedPx: number): boolean {
  return Math.abs(distancePx - expectedPx) < 1;
}

/** How far the row at `position` has moved from `fromTopPx`, or `undefined` once it is gone. */
function shiftOf(scroller: HTMLElement, position: number, fromTopPx: number): number | undefined {
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (positionOfRow(row) === position) {
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - fromTopPx;
    }
  }
  return undefined;
}

/**
 * Wheels one screen toward the head, checking every row on screen moved by exactly the turn and
 * that a sampled row stood only before it or after it on every frame and change; answers whether
 * the list's height changed, which a take-back at the head does.
 */
async function turnTowardHead(scroller: HTMLElement, turn: string): Promise<boolean> {
  const before = rowTopsOnScreen(scroller);
  const scrollHeightBeforePx = scroller.scrollHeight;
  // A row the turn leaves on screen, so it is drawn on every frame: one crossing the box's top.
  const [referencePosition, referenceTopPx] =
    [...before].find(([, topPx]) => topPx + FEED_HEIGHT_PX < scroller.clientHeight) ??
    expect.fail("a row crosses the box's top");
  const seenShifts = new Set<number | undefined>();
  const sample = (): void => {
    seenShifts.add(shiftOf(scroller, referencePosition, referenceTopPx));
  };
  let isSampling = true;
  const sampleFrame = (): void => {
    if (isSampling) {
      sample();
      requestAnimationFrame(sampleFrame);
    }
  };
  requestAnimationFrame(sampleFrame);
  const changes = new MutationObserver(sample);
  changes.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  await userEvent.wheel(scroller, { delta: { y: -FEED_HEIGHT_PX } });
  await endGesture();
  isSampling = false;
  changes.disconnect();

  const after = rowTopsOnScreen(scroller);
  const shifts = [...before].flatMap(([position, topPx]) => {
    const afterTopPx = after.get(position);
    return afterTopPx === undefined ? [] : [afterTopPx - topPx];
  });
  // A turn shorter than the box keeps a row on screen; none kept means the rows jumped further.
  expect({ turn, isAnyRowStillOnScreen: shifts.length > 0 }).toEqual({
    turn,
    isAnyRowStillOnScreen: true,
  });
  const strayRowShifts = shifts.filter((shift) => !isWithinGrain(shift, FEED_HEIGHT_PX));
  expect({ turn, strayRowShifts }).toEqual({ turn, strayRowShifts: [] });
  // Before the turn and after it, never between, never gone.
  const strayShifts = [...seenShifts].filter(
    (shift) =>
      shift === undefined || !(isWithinGrain(shift, 0) || isWithinGrain(shift, FEED_HEIGHT_PX)),
  );
  expect({ turn, strayShifts }).toEqual({ turn, strayShifts: [] });
  return scroller.scrollHeight !== scrollHeightBeforePx;
}

describe("reading back over a window that takes rows back at its head", () => {
  it(
    "moves every row on screen by exactly each wheel turn, on every frame",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { scroller, historyReads } = await mountLongToolHistory();
      let headTakeBackCount = 0;
      // From the tail the session opens at, back through pages its history serves.
      for (let screen = 0; screen < SCREEN_COUNT; screen += 1) {
        if (await turnTowardHead(scroller, `first read back, screen ${String(screen)}`)) {
          headTakeBackCount += 1;
        }
      }
      const readsOnTheWayUp = historyReads.length;
      expect(readsOnTheWayUp).toBeGreaterThan(0);
      // Down again, so the window lets its head go, then back over it.
      for (let screen = 0; screen < SCREEN_COUNT; screen += 1) {
        await userEvent.wheel(scroller, { delta: { y: FEED_HEIGHT_PX } });
        await endGesture();
      }
      for (let screen = 0; screen < SCREEN_COUNT; screen += 1) {
        if (await turnTowardHead(scroller, `second read back, screen ${String(screen)}`)) {
          headTakeBackCount += 1;
        }
      }
      // The controls: rows joined at the head on the way up, so the hold was asked, and the
      // second pass over the head read it again rather than finding it held.
      expect(headTakeBackCount).toBeGreaterThan(0);
      expect(historyReads.length).toBeGreaterThan(readsOnTheWayUp);
    },
  );
});
