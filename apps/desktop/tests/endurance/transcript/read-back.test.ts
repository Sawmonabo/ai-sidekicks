// The read-back budget: the longest task the window's renderer runs while a reader goes back from
// a session's tail to its first message and opens the eight-hundred-row table its first reply
// holds, read from the window's own task records in a DevTools trace.
//
// The session is the long-table-history scenario: its whole history delivered before it opens,
// so opening reads only the newest rows, then pulls at the top read it back a stretch at a time
// until the head. The fixture's clock stands still unless driven, so from the history's end on
// every frame of the window moves it with the wall clock and runs the frame work armed on it, as
// a person's app runs its timers and frames. The table's reply is too large to travel with its
// row, so it arrives as its size and the reader presses `Show full output`, as a person would;
// the land of that body, its parse and the table's first draw, is the figure. The read-back's
// own longest task before the press is printed beside it.
//
// The figure depends on how fast the machine runs the renderer, so it gates on the pinned runner
// class (`../pinned-runner-class.ts`) and is printed everywhere else. What makes a run a
// measurement holds on every machine: the walk reached the reply and its table drew. The negative
// control plants a task longer than the ceiling as the press lands and requires the reading to
// cross it, so a trace read from the wrong thread, or one that dropped the task records, fails.

import { loadavg } from "node:os";
import process from "node:process";

import type { CDPSession } from "playwright";
import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../../helpers/launch/body.js";
import { RUNNER_CLASS_DESCRIPTION, gateOnPinnedRunner } from "../pinned-runner-class.js";
import { endTraceRecording, startTraceRecording, type TraceEvent } from "../trace/recording.js";
import {
  CONVERSATION_SCROLLER_SELECTOR,
  SESSION_SCREEN_SELECTOR,
  TRANSCRIPT_ROW_SELECTOR,
  enduranceLaunchOptions,
  openRoute,
  startPacedDelivery,
  waitForIdleWindow,
} from "../workload.js";
import {
  TRANSCRIPT_GESTURE_GAP_MS,
  TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
} from "#renderer/features/transcript/viewport/caps.js";
import { formatRoute } from "#renderer/routing/routes.js";
import {
  LONG_TABLE_BODY_ROW_COUNT,
  LONG_TABLE_HISTORY_END_MS,
  LONG_TABLE_HISTORY_SCENARIO,
  LONG_TABLE_REQUEST,
} from "#fixtures/scenarios/long-table-history.js";

const bundleIsBuilt = fixtureBundleExists();

const longestTaskBudget = BudgetRegistry.load().requireBudget("transcript-read-back-longest-task");

const SESSION_ROUTE = formatRoute({
  kind: "session",
  sessionId: LONG_TABLE_HISTORY_SCENARIO.sessionId,
});

/** The table the press draws, as a window over its rows: every row and the head. */
const LONG_TABLE_SELECTOR = `${CONVERSATION_SCROLLER_SELECTOR} table[aria-rowcount="${String(
  LONG_TABLE_BODY_ROW_COUNT + 1,
)}"]`;

/** The trace categories that hold the renderer's tasks and the frames that name its thread. */
const TASK_TRACE_CATEGORIES: readonly string[] = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
];

/**
 * The words a large body's control opens with, before the body's size. The tail's tool calls
 * offer it too; the table's reply is the first message's answer, so its control is the first one
 * drawn after that message.
 */
const SHOW_FULL_OUTPUT_TEXT = "Show full output";

/** The control's accessible name, its size following the words. */
const SHOW_FULL_OUTPUT_NAME = new RegExp(`^${SHOW_FULL_OUTPUT_TEXT}`);

/** A reader's flick up the conversation: a stretch's height, at a quick hand's pace. */
const FLICK_SCREEN_HEIGHTS = TRANSCRIPT_STRETCH_SCREEN_HEIGHTS;
const FLICK_SPEED_PX_PER_SECOND = 8_000;

/** The pause between two flicks, long enough that each is a gesture of its own. */
const PAUSE_BETWEEN_FLICKS_MS = 2 * TRANSCRIPT_GESTURE_GAP_MS;

/** The trace marker set just before the press, which splits the read-back from the land. */
const PRESS_MARKER = "read-back: press show full output";

/** How long the negative control's planted task runs: past the ceiling on its own. */
const PLANTED_TASK_MS: number = longestTaskBudget.limit.canonicalValue + 100;

describe.skipIf(!bundleIsBuilt)("endurance — reading a long history back", () => {
  it("reads back to the first message and opens its 800-row table, with no task longer than the ceiling", async () => {
    const reading = await readBackOnce(undefined);
    const verdict = evaluateBudget(longestTaskBudget, reading.landLongestTaskMs);
    process.stdout.write(
      `[endurance] opening the first reply's table after reading back: longest renderer task ` +
        `${reading.landLongestTaskMs.toFixed(1)} ms against a ` +
        `${String(longestTaskBudget.limit.canonicalValue)} ms ceiling ` +
        `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget); the read-back before ` +
        `the press ${reading.readBackLongestTaskMs.toFixed(1)} ms; load ` +
        `${loadavg()
          .map((load) => load.toFixed(2))
          .join(" ")} — ${RUNNER_CLASS_DESCRIPTION}\n`,
    );
    gateOnPinnedRunner(
      verdict,
      `${longestTaskBudget.label}: the table's land ran a ` +
        `${reading.landLongestTaskMs.toFixed(1)} ms task`,
    );
  });

  it("negative control: a task planted as the press lands crosses the same ceiling", async () => {
    const reading = await readBackOnce(PLANTED_TASK_MS);
    expect(
      evaluateBudget(longestTaskBudget, reading.landLongestTaskMs).withinBudget,
      `a ${String(PLANTED_TASK_MS)} ms task planted as the press landed read as ` +
        `${reading.landLongestTaskMs.toFixed(1)} ms`,
    ).toBe(false);
  });
});

/** The longest renderer tasks of one run, in milliseconds, either side of the press. */
interface ReadBackReading {
  readonly readBackLongestTaskMs: number;
  readonly landLongestTaskMs: number;
}

/**
 * One launch: delivers the whole history with no session open and paces the clock from there,
 * opens the session at its tail, traces the pulls at the top and the read-back they set off until
 * the table's reply offers its full body, then the press and the land until the table is drawn.
 * `plantedTaskMs` plants one task that long as the press lands.
 */
async function readBackOnce(plantedTaskMs: number | undefined): Promise<ReadBackReading> {
  return await withLaunchedApp(
    enduranceLaunchOptions(LONG_TABLE_HISTORY_SCENARIO.id),
    async (appUnderTest) => {
      const stepTimeoutMs = appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS);
      const paceMs = appUnderTest.bodyAllowance.remainingMs();
      const stopPace = await startPacedDelivery(appUnderTest, {
        leadInMs: LONG_TABLE_HISTORY_END_MS,
        stretchMs: paceMs,
        durationMs: paceMs,
      });
      try {
        await openRoute(appUnderTest, SESSION_ROUTE, SESSION_SCREEN_SELECTOR);
        const scroller = appUnderTest.window.locator(CONVERSATION_SCROLLER_SELECTOR);
        await appUnderTest.window
          .locator(TRANSCRIPT_ROW_SELECTOR)
          .first()
          .waitFor({ state: "attached", timeout: stepTimeoutMs });
        await waitForIdleWindow(appUnderTest);
        expect(
          await scroller.getByText(LONG_TABLE_REQUEST, { exact: true }).count(),
          "the session opened with its first message already held",
        ).toBe(0);

        const cdpSession = await appUnderTest.application
          .context()
          .newCDPSession(appUnderTest.window);
        await startTraceRecording(cdpSession, TASK_TRACE_CATEGORIES);
        const isReplyHeld = await readBackToReply(appUnderTest, cdpSession);
        expect(isReplyHeld, "the read-back never reached the first reply").toBe(true);
        await waitForIdleWindow(appUnderTest);
        await appUnderTest.window.evaluate(
          ([marker, plantedMs]: [string, number | null]) => {
            console.timeStamp(marker);
            if (plantedMs !== null) {
              setTimeout(() => {
                const until = performance.now() + plantedMs;
                while (performance.now() < until) {
                  // A task that holds the thread for the planted time.
                }
              }, 0);
            }
          },
          [PRESS_MARKER, plantedTaskMs ?? null] as [string, number | null],
        );
        await scroller
          .getByRole("button", { name: SHOW_FULL_OUTPUT_NAME })
          .first()
          .click({ timeout: stepTimeoutMs });
        await appUnderTest.window
          .locator(LONG_TABLE_SELECTOR)
          .waitFor({ state: "attached", timeout: stepTimeoutMs });
        await waitForIdleWindow(appUnderTest);
        const events = await endTraceRecording(cdpSession);
        return readLongestTasks(events);
      } finally {
        await stopPace();
      }
    },
  );
}

/**
 * Flicks up the conversation from the pointer over it, a gesture at a time, until the table's
 * reply offers its full body, and answers whether it did. Each flick that reaches the top pulls
 * past it, which asks the history for a stretch before the head. It gives up once the drawn list
 * stops changing for a step's bound: an app that stopped reading back.
 */
async function readBackToReply(
  appUnderTest: AppUnderTest,
  cdpSession: CDPSession,
): Promise<boolean> {
  const scroller = appUnderTest.window.locator(CONVERSATION_SCROLLER_SELECTOR);
  const box = (await scroller.boundingBox()) ?? expect.fail("the conversation draws its box");
  const pointer = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  await appUnderTest.window.mouse.move(pointer.x, pointer.y);
  const flickPx = Math.round(
    FLICK_SCREEN_HEIGHTS * (await scroller.evaluate((element) => element.clientHeight)),
  );
  const stallMs = appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS);
  let drawnList = "";
  let changedAtMs = performance.now();
  for (;;) {
    const reading = await scroller.evaluate(readDrawnList, {
      rowSelector: TRANSCRIPT_ROW_SELECTOR,
      request: LONG_TABLE_REQUEST,
      controlName: SHOW_FULL_OUTPUT_TEXT,
    });
    if (reading.isReplyHeld) {
      return true;
    }
    if (reading.drawnList !== drawnList) {
      drawnList = reading.drawnList;
      changedAtMs = performance.now();
    } else if (performance.now() - changedAtMs > stallMs) {
      return false;
    }
    await cdpSession.send("Input.synthesizeScrollGesture", {
      ...pointer,
      // Positive scrolls up, toward the conversation's first row.
      yDistance: flickPx,
      speed: FLICK_SPEED_PX_PER_SECOND,
      gestureSourceType: "mouse",
      preventFling: false,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PAUSE_BETWEEN_FLICKS_MS);
    });
  }
}

/** What one look at the drawn list reads: where it stands, and whether the reply is held. */
interface DrawnListReading {
  /** The list's height and offset and its first drawn row's words, which move as it reads back. */
  readonly drawnList: string;
  /** The first message is drawn, with a control below it: the first one below is its reply's. */
  readonly isReplyHeld: boolean;
}

/** Runs in the page: reads the drawn list for `readBackToReply`. */
function readDrawnList(
  scroller: Element,
  names: { readonly rowSelector: string; readonly request: string; readonly controlName: string },
): DrawnListReading {
  const rows = [...scroller.querySelectorAll(names.rowSelector)];
  const requestRow = rows.find((row) => (row.textContent ?? "").includes(names.request));
  const firstControl = [...scroller.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").startsWith(names.controlName),
  );
  return {
    drawnList: [scroller.scrollHeight, scroller.scrollTop, rows[0]?.textContent ?? ""].join("|"),
    isReplyHeld:
      requestRow !== undefined &&
      firstControl !== undefined &&
      (requestRow.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  };
}

/**
 * The longest task on the window's renderer main thread before the press and from the press on,
 * in milliseconds. Throws when the trace holds no press marker or no task on either side.
 */
function readLongestTasks(events: readonly TraceEvent[]): ReadBackReading {
  const windowThread = windowThreadOf(events);
  const pressUs = events.find(
    (event) =>
      event.name === "TimeStamp" &&
      threadOf(event) === windowThread &&
      (event.args?.["data"] as { message?: unknown } | undefined)?.message === PRESS_MARKER,
  )?.ts;
  if (pressUs === undefined) {
    throw new Error("the trace holds no press marker on the window's renderer main thread");
  }
  const tasks = events.filter(
    (event) => event.ph === "X" && event.name === "RunTask" && threadOf(event) === windowThread,
  );
  return {
    readBackLongestTaskMs: longestMs(tasks.filter((task) => task.ts + (task.dur ?? 0) <= pressUs)),
    landLongestTaskMs: longestMs(tasks.filter((task) => task.ts + (task.dur ?? 0) > pressUs)),
  };
}

/**
 * The window's renderer main thread: the renderer thread that ran the most animation frames, as the
 * window's own does. Throws when the trace holds no animation frame on one.
 */
function windowThreadOf(events: readonly TraceEvent[]): string {
  const rendererMains = new Set(
    events
      .filter(
        (event) =>
          event.ph === "M" &&
          event.name === "thread_name" &&
          event.args?.["name"] === "CrRendererMain",
      )
      .map(threadOf),
  );
  const frameCountByThread = new Map<string, number>();
  for (const event of events) {
    const thread = threadOf(event);
    if (event.name === "FireAnimationFrame" && rendererMains.has(thread)) {
      frameCountByThread.set(thread, (frameCountByThread.get(thread) ?? 0) + 1);
    }
  }
  const windowThread = [...frameCountByThread].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (windowThread === undefined) {
    throw new Error("the trace holds no animation frame on a renderer main thread");
  }
  return windowThread;
}

/** The longest of some tasks, in milliseconds. Throws when there are none. */
function longestMs(tasks: readonly TraceEvent[]): number {
  if (tasks.length === 0) {
    throw new Error("the trace holds no task on the window's renderer main thread");
  }
  return Math.max(...tasks.map((task) => task.dur ?? 0)) / 1000;
}

/** The process and thread a record ran on, as one key. */
function threadOf(event: TraceEvent): string {
  return `${String(event.pid)}:${String(event.tid)}`;
}
