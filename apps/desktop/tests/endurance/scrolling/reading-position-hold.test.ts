// The reader's place as rows join above them, in the app over the long conversation: flinging up
// from the tail, rows join above the reader and the hold moves the offset by their height. The
// commit that lays the joined rows out draws the rows the hold ends on, so no change to the DOM
// both mounts a row and takes it down, and the row the reader saw stays where it stood.
//
// The app's script runs in the window that opened the frame's, so the case reads only the DOM:
// rows are told apart as elements, and the screen is read on every scroll event and frame.

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../../helpers/launch/body.js";
import { TRANSCRIPT_ROW_BOX_SELECTOR } from "../transcript/window-read.js";
import {
  CONVERSATION_SCROLLER_SELECTOR,
  SESSION_SCREEN_SELECTOR,
  advanceScenario,
  enduranceLaunchOptions,
  openRoute,
  waitForIdleWindow,
} from "../workload.js";
import { TRANSCRIPT_GESTURE_GAP_MS } from "#renderer/features/transcript/viewport/caps.js";
import { formatRoute } from "#renderer/routing/routes.js";
import {
  LONG_CONVERSATION_HISTORY_END_MS,
  LONG_CONVERSATION_SCENARIO,
} from "#fixtures/scenarios/long-conversation.js";

/** The flings up from the tail: enough for pages to join at the head and rows inside the log. */
const FLING_COUNT = 9;
/** One fling's travel, in screen heights. */
const FLING_SCREEN_HEIGHTS = 2;
/** The fling's speed, in pixels a second. */
const FLING_SPEED_PX_PER_SECOND = 8_000;
/** The pause between two flings: twice what ends a gesture, so each fling is one of its own. */
const PAUSE_BETWEEN_FLINGS_MS = 2 * TRANSCRIPT_GESTURE_GAP_MS;
/** How far the reader's row may move and still stand where it stood: a device pixel. */
const GRAIN_PX = 1;

/** What the flings did to the rows, as the DOM showed it. */
interface HoldReading {
  /** The rows one change to the DOM both mounted and took down, by the start of their text. */
  readonly churned: readonly string[];
  /** How far the reader's row moved on screen in each change that moved it past a pixel. */
  readonly readerRowShiftsPx: readonly number[];
  /** How many changes to the rows also moved the offset: holds that really moved. */
  readonly movingHoldCount: number;
}

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("endurance — the reader's place as rows join above", () => {
  it("lays joined rows out where the hold ends, the reader's row held to a pixel", async () => {
    await withLaunchedApp(enduranceLaunchOptions(LONG_CONVERSATION_SCENARIO.id), async (app) => {
      await openRoute(
        app,
        formatRoute({ kind: "session", sessionId: LONG_CONVERSATION_SCENARIO.sessionId }),
        SESSION_SCREEN_SELECTOR,
      );
      await advanceScenario(app, LONG_CONVERSATION_HISTORY_END_MS);
      await app.window
        .locator(TRANSCRIPT_ROW_BOX_SELECTOR)
        .first()
        .waitFor({
          state: "attached",
          timeout: app.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        });
      const scroller = app.window.locator(CONVERSATION_SCROLLER_SELECTOR);
      const box = (await scroller.boundingBox()) ?? expect.fail("the conversation draws its box");
      const pointer = {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
      };
      await app.window.mouse.move(pointer.x, pointer.y);
      await waitForIdleWindow(app);
      const screenHeightPx = await scroller.evaluate((element) => element.clientHeight);

      await scroller.evaluate(watchHolds, {
        rowSelector: TRANSCRIPT_ROW_BOX_SELECTOR,
        grainPx: GRAIN_PX,
      });
      const cdpSession = await app.application.context().newCDPSession(app.window);
      await cdpSession.send("Input.synthesizeScrollGesture", {
        ...pointer,
        yDistance: Math.round(FLING_SCREEN_HEIGHTS * screenHeightPx),
        speed: FLING_SPEED_PX_PER_SECOND,
        gestureSourceType: "mouse",
        preventFling: false,
        repeatCount: FLING_COUNT,
        repeatDelayMs: PAUSE_BETWEEN_FLINGS_MS,
      });
      await waitForIdleWindow(app);
      const reading = await scroller.evaluate(() =>
        (window as unknown as { readingHold: { read: () => HoldReading } }).readingHold.read(),
      );

      // The control: rows joined above the reader and the hold moved the offset for them.
      expect(reading.movingHoldCount).toBeGreaterThan(0);
      expect({ churned: reading.churned, shifts: reading.readerRowShiftsPx }).toEqual({
        churned: [],
        shifts: [],
      });
    });
  });
});

/**
 * Runs in the page: reads the reader's row and the offset on every scroll event and frame, and on
 * every change to the rows notes each row it both mounted and took down, how far the reader's row
 * moved, and whether the offset moved with it. Rows are told apart as elements: rows of the
 * conversation can read alike, and a row drawn again is a new element.
 */
function watchHolds(
  scrollerElement: HTMLElement,
  options: { readonly rowSelector: string; readonly grainPx: number },
): void {
  const churned: string[] = [];
  const readerRowShiftsPx: number[] = [];
  let movingHoldCount = 0;
  // A row taken down is detached by the time a change is read, so no selector matches it; the
  // rows are told by their parent, the box the window places them in, instead.
  const rowParent = scrollerElement.querySelector(options.rowSelector)?.parentNode;
  const rowsAmong = (
    records: readonly MutationRecord[],
    side: "addedNodes" | "removedNodes",
  ): Element[] =>
    records
      .filter((record) => record.target === rowParent)
      .flatMap((record) => [...record[side]])
      .filter((node): node is Element => node instanceof Element);
  let readerRow: { readonly element: Element; readonly topPx: number } | undefined;
  let readScrollTopPx = scrollerElement.scrollTop;
  const readScreen = (): void => {
    const boxTopPx = scrollerElement.getBoundingClientRect().top;
    const topRow = [...scrollerElement.querySelectorAll(options.rowSelector)]
      .map((element) => ({ element, topPx: element.getBoundingClientRect().top }))
      .filter(({ element }) => element.getBoundingClientRect().bottom > boxTopPx + options.grainPx)
      .sort((first, second) => first.topPx - second.topPx)[0];
    readerRow = topRow;
    readScrollTopPx = scrollerElement.scrollTop;
  };
  const onFrame = (): void => {
    readScreen();
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  document.addEventListener("scroll", readScreen, { capture: true, passive: true });
  new MutationObserver((records) => {
    const mounted = rowsAmong(records, "addedNodes");
    const takenDown = new Set(rowsAmong(records, "removedNodes"));
    churned.push(
      ...mounted.filter((row) => takenDown.has(row)).map((row) => row.textContent.slice(0, 60)),
    );
    const offsetMovedPx = scrollerElement.scrollTop - readScrollTopPx;
    if (offsetMovedPx > options.grainPx) {
      movingHoldCount += 1;
    }
    if (readerRow !== undefined && readerRow.element.isConnected) {
      const shiftPx = readerRow.element.getBoundingClientRect().top - readerRow.topPx;
      // The reader flings only toward the head, so an offset that fell since the last read is
      // their scroll, which moves their row by as much; one that rose is the app's.
      const isReaderScroll =
        offsetMovedPx < 0 && Math.abs(shiftPx + offsetMovedPx) <= options.grainPx;
      if (Math.abs(shiftPx) > options.grainPx && !isReaderScroll) {
        readerRowShiftsPx.push(Math.round(shiftPx));
      }
    }
    readScreen();
  }).observe(scrollerElement, { childList: true, subtree: true });
  (window as unknown as { readingHold: { read: () => HoldReading } }).readingHold = {
    read: () => ({ churned, readerRowShiftsPx, movingHoldCount }),
  };
}
