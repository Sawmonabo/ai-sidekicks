// The scrolling budgets: a fling with its momentum and a wheel scroll on each scroller but the
// conversation, while four agent lanes stream, read from the window's own frame and input records
// in a DevTools trace. The fling is a touch drag let go at speed, the one fling the DevTools
// protocol can make; its momentum reaches the window as the browser's inertial scroll updates.
//
// Each trace gives two readings. The gaps between the frames the window presented while a fling
// moved the content, from the frame that drew its first moving update to the frame that drew its
// last: one refresh each when no frame is missed. And for each update that moved the content, the
// time from its input reaching the window to the submit of the frame that drew it: within two
// refreshes it was drawn in the first frame after the input, since an input that arrives just after
// a frame began waits at most a refresh for the next one, which submits within the refresh after.
// The input is the wheel turn or touch move the update was made from: it reaches the window where
// its trip from the browser ends (`BrowserMainToRendererCompositor`), which is before the update's
// own when a handler holds it. The frame that drew the update is the one its `display_trace_id`
// names.
//
// Whether an update moved the content is Chromium's own verdict, its `ScrollJankV4` record's damage
// type. An update that arrives once the content is at its end moves nothing and has no frame to be
// drawn in: Chromium closes its record on whatever frame the window submits next, so counting it
// would report a delay nobody can see.
//
// The ceilings are one and two refreshes of a 120 Hz display. The comparison is made where the
// trace says the display refreshes at least that often and printed elsewhere, since on a slower
// display one refresh is longer than the frame ceiling. Chromium scrolls each of these scrollers off
// the main thread, so main-thread work cannot make a fling miss a frame; the frame control plants
// drawing too heavy for one refresh instead. The input control holds each wheel turn in a handler,
// which holds back the update the browser makes of it.
//
// Every run is a fresh launch, because the scenario's frozen clock does not rewind. The frame-time
// sampler (`frame-sampling.ts`) drives the script one step per frame, and each gesture starts once
// four lanes are mid-turn (`streaming-lanes.ts`).

import process from "node:process";

import type { CDPSession, Locator } from "playwright";
import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";
import { percentileByNearestRank } from "../helpers/sample-statistics.js";
import { MEASURED_RUN_COUNT, sampleFrameTimings } from "./frame-sampling.js";
import { peakConcurrentStreamingRuns } from "./streaming-lanes.js";
import {
  ENDURANCE_LAUNCH_OPTIONS,
  advanceScenario,
  openConcurrentStreamingSessionRoute,
  openRoute,
} from "./workload.js";
import { SCENARIO_FIXTURE_GLOBAL } from "#renderer/app/fixture/global-names.js";
import { formatRoute } from "#renderer/routing/routes.js";
import {
  CONCURRENT_STREAMING_LANE_COUNT,
  CONCURRENT_STREAMING_SCENARIO,
} from "#fixtures/scenarios/concurrent-streaming.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { BudgetRegistry } from "../helpers/budget/registry.js";
import { evaluateBudget } from "../helpers/budget/evaluation.js";

const bundleIsBuilt = fixtureBundleExists();

/** The row bounding the gaps between presented frames through a fling. */
const FRAME_GAP_BUDGET_ID = "scrolling-four-lanes";

/** The row bounding each input's wait for the frame that draws it. */
const INPUT_TO_FRAME_BUDGET_ID = "scrolling-input-to-frame-four-lanes";

const budgetRegistry = BudgetRegistry.load();
const frameGapBudget = budgetRegistry.requireBudget(FRAME_GAP_BUDGET_ID);
const inputToFrameBudget = budgetRegistry.requireBudget(INPUT_TO_FRAME_BUDGET_ID);

/** The two gestures the row names. */
type ScrollGesture = "fling" | "wheel";

const SCROLL_GESTURES: readonly ScrollGesture[] = ["fling", "wheel"];

/** A scroller the row covers, and how a launch puts it on screen with enough in it to scroll. */
interface ScrollHost {
  /** How the printed line and a failure name it. */
  readonly name: string;
  readonly scrollerSelector: string;
  readonly open: (appUnderTest: AppUnderTest) => Promise<void>;
}

/**
 * What a negative control adds before its gesture: a wheel handler that holds the main thread on
 * every turn, added as one that may cancel the scroll so the browser waits for it; or see-through
 * layers over the scroller, each blurring what is behind it, which the display redraws on every
 * frame the content moves.
 */
type Plant =
  | { readonly kind: "held-wheel"; readonly holdMs: number }
  | { readonly kind: "blurring-layers"; readonly layerCount: number };

/** What one launch measured over one gesture. */
interface ScrollRun {
  readonly reading: ScrollReading;
  readonly beatsAtGestureStart: number;
  readonly beatsAtGestureEnd: number;
  /** Whether the sampler was still driving the script when the gesture came to rest. */
  readonly didSamplingOutlastGesture: boolean;
}

/** What one trace says about one gesture. */
interface ScrollReading {
  /** One refresh of the display the window presented on, in milliseconds. */
  readonly refreshIntervalMs: number;
  /** The gaps between presented frames while the gesture moved the content, in milliseconds. */
  readonly presentedFrameGapsMs: readonly number[];
  readonly movingUpdateCount: number;
  /** Updates with no frame of their own: they moved nothing, or Chromium merged them into the next. */
  readonly stillUpdateCount: number;
  /** Each moving update that no presented frame drew. */
  readonly undrawnUpdates: readonly string[];
  /** The moving update that waited longest for the frame that drew it. */
  readonly slowestInputToSubmit: InputToSubmit;
}

/** One moving update's wait, from its input reaching the window to its frame's submit. */
interface InputToSubmit {
  /** The update by type and time into the scroll, as a printed line or a failure names it. */
  readonly update: string;
  readonly durationMs: number;
}

/** One trace record, with only the members these readings use. */
interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly ts: number;
  readonly id?: string;
  readonly id2?: { readonly local?: string };
  readonly args?: Record<string, unknown>;
}

/** The start and the end of one async trace record. */
interface TraceSpan {
  readonly begin: TraceEvent;
  readonly end: TraceEvent;
}

/** The arrivals and submits recorded under one async id, in trace microseconds. */
interface StageTimes {
  readonly arrivedUs: number[];
  readonly submittedUs: number[];
}

/** One compositor frame the window submitted, as Chromium's report of it describes it. */
interface SubmittedFrame {
  readonly submittedUs: number;
  readonly presentedAtUs: number | undefined;
}

/** Every frame, input and scroll record these readings use carries this category. */
const TRACE_CATEGORIES: readonly string[] = ["benchmark"];

/**
 * Members holding 64-bit trace ids, which lose their low digits as a JavaScript number; they are
 * read as their source text so two frames' ids never compare equal.
 */
const TRACE_ID_MEMBERS: ReadonlySet<string> = new Set(["display_trace_id", "result_id"]);

const SCROLL_UPDATE_TYPES: ReadonlySet<string> = new Set([
  "FIRST_GESTURE_SCROLL_UPDATE",
  "GESTURE_SCROLL_UPDATE",
  "INERTIAL_GESTURE_SCROLL_UPDATE",
]);

const PRESENTED_FRAME_STATES: ReadonlySet<string> = new Set([
  "STATE_PRESENTED_ALL",
  "STATE_PRESENTED_PARTIAL",
]);

/** Chromium's damage type for a scroll frame that moved the content. */
const MOVING_DAMAGE_TYPE = "DAMAGING";

/** The fling's drag, in pixels a second: a quick flick, whose momentum carries on past the drag. */
const FLING_SPEED_PX_PER_SECOND = 3000;

/** The share of the scroll range the fling drags; its momentum carries the rest of the travel. */
const FLING_DRAG_SHARE_OF_RANGE = 0.3;

const WHEEL_NOTCH_COUNT = 10;

/** One wheel notch, in pixels. */
const WHEEL_NOTCH_PX = 100;

/** Frames between wheel notches: a notch a person turns, not a burst the browser merges. */
const FRAMES_BETWEEN_WHEEL_NOTCHES = 10;

/** Lines typed into the draft: several times what its box shows before it scrolls. */
const DRAFT_LINE_COUNT = 80;

/** How far each poll moves the clock while a screen waits on a scripted read. */
const CLOCK_STEP_MS = 50;

/** How long the planted wheel handler holds the main thread: several refreshes at any rate. */
const WHEEL_HOLD_MS = 30;

/** Blurring layers stacked over the scroller: more drawing than one refresh holds. */
const BLURRING_LAYER_COUNT = 48;

/** The delivered-beat count at which four lanes first stream at once. */
const FOUR_LANE_BEAT_COUNT: number = firstFourLaneBeatCount();

const SCREEN_REGION: ScrollHost = {
  name: "the screen region",
  scrollerSelector: ".meridian-frame__screen",
  open: async (appUnderTest) => {
    // The keyboard page's list is the settings page that runs longest.
    await openRoute(
      appUnderTest,
      formatRoute({ kind: "settings", page: "keyboard" }),
      ".meridian-frame__screen .meridian-keymap",
    );
  },
};

const SCROLL_HOSTS: readonly ScrollHost[] = [
  SCREEN_REGION,
  {
    name: "the draft box",
    scrollerSelector: ".meridian-composer .meridian-text-box",
    open: async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      await appUnderTest.window.getByRole("textbox", { name: "Message" }).focus();
      await appUnderTest.window.keyboard.insertText(
        Array.from(
          { length: DRAFT_LINE_COUNT },
          (_, index) => `line ${String(index + 1)} of the draft`,
        ).join("\n"),
      );
    },
  },
  {
    name: "the diff pane",
    scrollerSelector: ".meridian-pane--diff .meridian-diff",
    open: async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      await appUnderTest.window.evaluate(
        (hash: string) => {
          globalThis.location.hash = hash;
        },
        formatRoute({ kind: "workflows", tab: "runs", runId: WORKFLOW_RUN_IDS.succeeded }),
      );
      const openInReview = appUnderTest.window.getByRole("button", { name: "Open in Review" });
      await walkClockUntilVisible(appUnderTest, openInReview, "the run page's Open in Review");
      await openInReview.click();
      await walkClockUntilVisible(
        appUnderTest,
        appUnderTest.window.locator(".meridian-pane--diff .meridian-diff"),
        "the run's diff in Review",
      );
    },
  },
];

describe.skipIf(!bundleIsBuilt)(
  "endurance — scrolling with the concurrent-streaming session open",
  () => {
    for (const host of SCROLL_HOSTS) {
      it(`${host.name}: a frame each refresh through a fling, each input in the first frame after it`, async () => {
        const flingGapPercentiles: number[] = [];
        const undrawnUpdates: string[] = [];
        const slowestInputToSubmitByRun: InputToSubmit[] = [];
        const runSummaries: string[] = [];
        let slowestRefreshMs = 0;
        for (const gesture of SCROLL_GESTURES) {
          for (let runIndex = 1; runIndex <= MEASURED_RUN_COUNT; runIndex += 1) {
            const run = await scrollOnce(host, gesture, undefined);
            const label = `${host.name}, ${gesture} ${String(runIndex)}`;
            expectFourLanesThroughGesture(run, label);
            const { reading } = run;
            slowestRefreshMs = Math.max(slowestRefreshMs, reading.refreshIntervalMs);
            if (gesture === "fling") {
              flingGapPercentiles.push(percentileByNearestRank(reading.presentedFrameGapsMs, 0.95));
            }
            undrawnUpdates.push(...reading.undrawnUpdates.map((update) => `${label}: ${update}`));
            slowestInputToSubmitByRun.push({
              update: `${label}: ${reading.slowestInputToSubmit.update}`,
              durationMs: reading.slowestInputToSubmit.durationMs,
            });
            runSummaries.push(
              `${gesture} ${String(runIndex)}: ${String(reading.movingUpdateCount)} moving, ` +
                `${String(reading.stillUpdateCount)} still, input to submit up to ` +
                `${reading.slowestInputToSubmit.durationMs.toFixed(2)} ms`,
            );
          }
        }
        const flingGapP95 = percentileByNearestRank(flingGapPercentiles, 0.5);
        const slowestInputToSubmit = slowestOf(slowestInputToSubmitByRun);
        const frameGapVerdict = evaluateBudget(frameGapBudget, flingGapP95);
        const inputVerdict = evaluateBudget(inputToFrameBudget, slowestInputToSubmit.durationMs);
        const isComparable = isComparableRefresh(slowestRefreshMs);

        process.stdout.write(
          `[endurance] scrolling ${host.name}: presented-frame gap p95 through a fling ` +
            `${flingGapP95.toFixed(2)} ms (median of ${String(MEASURED_RUN_COUNT)} runs: ` +
            `${flingGapPercentiles.map((value) => value.toFixed(2)).join(", ")}) ` +
            `of a ${String(frameGapBudget.limit.canonicalValue)} ms ceiling ` +
            `(${(frameGapVerdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
            `slowest input to submit ${slowestInputToSubmit.durationMs.toFixed(2)} ms ` +
            `(${slowestInputToSubmit.update}) of a ` +
            `${String(inputToFrameBudget.limit.canonicalValue)} ms ceiling ` +
            `(${(inputVerdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
            `${runSummaries.join("; ")} — one refresh is ${slowestRefreshMs.toFixed(3)} ms, so ` +
            `${isComparable ? "these readings gate" : "these readings are reported and gate nothing"}\n`,
        );

        if (!isComparable) {
          // Not a skip: the instrument ran and the figures are printed. Only the comparison is
          // withheld, since no frame cadence on this display could meet a 120 Hz ceiling.
          return;
        }
        expect(
          frameGapVerdict.withinBudget,
          `${frameGapBudget.label}: ${host.name}'s fling presented frames ` +
            `${flingGapP95.toFixed(2)} ms apart at the 95th percentile, against a ` +
            `${String(frameGapBudget.limit.canonicalValue)} ms ceiling`,
        ).toBe(true);
        expect(
          inputVerdict.withinBudget,
          `${inputToFrameBudget.label}: ${slowestInputToSubmit.update} waited ` +
            `${slowestInputToSubmit.durationMs.toFixed(2)} ms from its input reaching the window ` +
            `to its frame's submit, against a ` +
            `${String(inputToFrameBudget.limit.canonicalValue)} ms ceiling`,
        ).toBe(true);
        expect(
          undrawnUpdates,
          `${host.name}: scroll updates that moved the content and no presented frame drew`,
        ).toStrictEqual([]);
      });
    }

    it("negative control: a draw heavier than one refresh misses frames through a fling", async () => {
      // Without this the cases above could pass over a reader that saw one refresh between
      // frames whatever the window drew.
      const { reading } = await scrollOnce(SCREEN_REGION, "fling", {
        kind: "blurring-layers",
        layerCount: BLURRING_LAYER_COUNT,
      });
      const heavyGapP95 = percentileByNearestRank(reading.presentedFrameGapsMs, 0.95);
      process.stdout.write(
        `[endurance] scrolling under ${String(BLURRING_LAYER_COUNT)} blurring layers: ` +
          `presented-frame gap p95 ${heavyGapP95.toFixed(2)} ms, ` +
          `${String(reading.movingUpdateCount)} moving updates\n`,
      );
      if (!isComparableRefresh(reading.refreshIntervalMs)) {
        return;
      }

      expect(
        evaluateBudget(frameGapBudget, heavyGapP95).withinBudget,
        "a fling whose every frame takes the display longer than one refresh to draw passed the " +
          "frame ceiling, so the reading would report green over the frames it exists to catch",
      ).toBe(false);
    });

    it("negative control: wheel input held by a wheel handler crosses the input ceiling", async () => {
      // Without this the input reading could pass over a reader that timed each update from its
      // own arrival, after the hold, rather than from the wheel turn it was made from.
      const { reading } = await scrollOnce(SCREEN_REGION, "wheel", {
        kind: "held-wheel",
        holdMs: WHEEL_HOLD_MS,
      });
      const { slowestInputToSubmit } = reading;
      process.stdout.write(
        `[endurance] scrolling under a planted ${String(WHEEL_HOLD_MS)} ms wheel handler: ` +
          `${String(reading.movingUpdateCount)} moving updates, slowest input to submit ` +
          `${slowestInputToSubmit.durationMs.toFixed(2)} ms (${slowestInputToSubmit.update})\n`,
      );
      if (!isComparableRefresh(reading.refreshIntervalMs)) {
        return;
      }

      expect(
        evaluateBudget(inputToFrameBudget, slowestInputToSubmit.durationMs).withinBudget,
        "a wheel scroll whose handler held each turn for several refreshes passed the input " +
          "ceiling, so the reading would report green over the wait it exists to catch",
      ).toBe(false);
    });
  },
);

/**
 * One launch: puts the host on screen, rests the pointer over it, then traces one gesture while
 * the sampler streams the script, with what a negative control plants when it plants something.
 */
async function scrollOnce(
  host: ScrollHost,
  gesture: ScrollGesture,
  planted: Plant | undefined,
): Promise<ScrollRun> {
  return await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
    await host.open(appUnderTest);
    const scroller = appUnderTest.window.locator(host.scrollerSelector);
    const box = await scroller.boundingBox();
    if (box === null) {
      throw new Error(`${host.name} (${host.scrollerSelector}) has no box to scroll over`);
    }
    const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await appUnderTest.window.mouse.move(pointer.x, pointer.y);
    await waitForIdleWindow(appUnderTest);
    const geometry = await scroller.evaluate((element) => ({
      offset: element.scrollTop,
      range: element.scrollHeight - element.clientHeight,
    }));
    if (geometry.range <= 0) {
      throw new Error(`${host.name} shows everything it holds, so there is nothing to scroll`);
    }
    // Toward the far end: down from the top half, up from the bottom half.
    const direction = geometry.offset < geometry.range / 2 ? 1 : -1;
    if (planted !== undefined) {
      await plant(scroller, planted);
    }

    const cdpSession = await appUnderTest.application.context().newCDPSession(appUnderTest.window);
    await cdpSession.send("Tracing.start", {
      traceConfig: {
        recordMode: "recordAsMuchAsPossible",
        includedCategories: [...TRACE_CATEGORIES],
      },
      transferMode: "ReturnAsStream",
    });
    const samplingEnd = sampleFrameTimings(appUnderTest, 0).then(() => performance.now());
    await waitForFourLanes(appUnderTest);
    const beatsAtGestureStart = await readDeliveredBeatCount(appUnderTest);
    if (gesture === "fling") {
      const waitForScrollEnd = await armScrollEnd(appUnderTest, scroller);
      await cdpSession.send("Input.synthesizeScrollGesture", {
        x: pointer.x,
        y: pointer.y,
        yDistance: -direction * Math.round(geometry.range * FLING_DRAG_SHARE_OF_RANGE),
        speed: FLING_SPEED_PX_PER_SECOND,
        // A synthesized drag stops dead at its last move unless it is let fling.
        preventFling: false,
        gestureSourceType: "touch",
      });
      await waitForScrollEnd();
    } else {
      await wheelNotches(appUnderTest, scroller, direction);
    }
    const beatsAtGestureEnd = await readDeliveredBeatCount(appUnderTest);
    const gestureEndedAtMs = performance.now();
    const reading = readScrollTrace(parseTrace(await endTracing(cdpSession)));
    const samplingEndedAtMs = await samplingEnd;
    return {
      reading,
      beatsAtGestureStart,
      beatsAtGestureEnd,
      didSamplingOutlastGesture: samplingEndedAtMs > gestureEndedAtMs,
    };
  });
}

/** Adds what a negative control plants to the scroller, or over it. */
async function plant(scroller: Locator, planted: Plant): Promise<void> {
  if (planted.kind === "held-wheel") {
    await scroller.evaluate((element, holdMs) => {
      element.addEventListener(
        "wheel",
        () => {
          const holdUntil = performance.now() + holdMs;
          while (performance.now() < holdUntil) {
            /* hold the main thread, the way a handler over its budget does */
          }
        },
        { passive: false },
      );
    }, planted.holdMs);
    return;
  }
  await scroller.evaluate((element, layerCount) => {
    const box = element.getBoundingClientRect();
    for (let index = 0; index < layerCount; index += 1) {
      const layer = document.createElement("div");
      Object.assign(layer.style, {
        position: "fixed",
        left: `${String(box.left)}px`,
        top: `${String(box.top)}px`,
        width: `${String(box.width)}px`,
        height: `${String(box.height)}px`,
        zIndex: "2147483647",
        // Through to the scroller, so the gesture still lands on it.
        pointerEvents: "none",
        // A radius of its own, so no layer is drawn as a copy of another.
        backdropFilter: `blur(${String(8 + index)}px)`,
      });
      document.body.append(layer);
    }
  }, planted.layerCount);
}

/**
 * Whether a display refreshing this often can meet the ceilings at all: one refresh longer than
 * the frame ceiling is a display slower than the rows' own rate.
 */
function isComparableRefresh(refreshIntervalMs: number): boolean {
  return refreshIntervalMs <= frameGapBudget.limit.canonicalValue;
}

/** Asserts four lanes were mid-turn during the gesture and the script was driven throughout it. */
function expectFourLanesThroughGesture(run: ScrollRun, label: string): void {
  expect(
    peakConcurrentStreamingRuns(
      CONCURRENT_STREAMING_SCENARIO.beats,
      run.beatsAtGestureStart,
      run.beatsAtGestureEnd,
    ),
    `fewer than four agent lanes were mid-turn during ${label}, so it scrolled an app that was ` +
      "not doing the work the budget row names",
  ).toBe(CONCURRENT_STREAMING_LANE_COUNT);
  expect(
    run.didSamplingOutlastGesture,
    `the sampler stopped driving the script before ${label} came to rest`,
  ).toBe(true);
}

/** The delivered-beat count at which four lanes first stream at once, read off the script. */
function firstFourLaneBeatCount(): number {
  const beats = CONCURRENT_STREAMING_SCENARIO.beats;
  for (let beatCount = 0; beatCount < beats.length; beatCount += 1) {
    if (
      peakConcurrentStreamingRuns(beats, beatCount, beatCount + 1) ===
      CONCURRENT_STREAMING_LANE_COUNT
    ) {
      return beatCount;
    }
  }
  throw new Error("the concurrent-streaming script never has four lanes streaming at once");
}

/** How many beats the scenario has delivered; throws when the build exposes no scenario handle. */
async function readDeliveredBeatCount(appUnderTest: AppUnderTest): Promise<number> {
  const beatCount = await advanceScenario(appUnderTest, 0);
  if (beatCount === null) {
    throw new Error(`${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build`);
  }
  return beatCount;
}

/** Waits, on the window's own frames, for the sampler to bring the script to four lanes. */
async function waitForFourLanes(appUnderTest: AppUnderTest): Promise<void> {
  await appUnderTest.window.waitForFunction(
    ([scenarioGlobalName, beatCount]: [string, number]) => {
      // The scenario's handle is the console document's, which opened this window.
      const consoleRealm = (window.opener ?? globalThis) as unknown as Record<
        string,
        { deliveredBeatCount(): number } | undefined
      >;
      return (consoleRealm[scenarioGlobalName]?.deliveredBeatCount() ?? 0) >= beatCount;
    },
    [SCENARIO_FIXTURE_GLOBAL, FOUR_LANE_BEAT_COUNT] as [string, number],
    { timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS) },
  );
}

/**
 * Moves the scenario's clock a step at a time until `target` is drawn: the screen's reads answer
 * on that clock, so it would never draw while the clock stands still.
 */
async function walkClockUntilVisible(
  appUnderTest: AppUnderTest,
  target: Locator,
  description: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await advanceScenario(appUnderTest, CLOCK_STEP_MS);
        return await target.isVisible();
      },
      {
        timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        message: `${description} was never drawn`,
      },
    )
    .toBe(true);
}

/**
 * Waits for the window's next idle period, which is when a bar that waits for idle starts, so the
 * gesture lands on the scrollers as a person who paused over them finds them.
 */
async function waitForIdleWindow(appUnderTest: AppUnderTest): Promise<void> {
  await appUnderTest.window.evaluate(
    async (timeoutMs: number) =>
      await new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: timeoutMs });
      }),
    appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  );
}

/**
 * Arms a wait for the scroller's next `scrollend` in the window now, before the gesture is sent,
 * and returns the call that waits for it; the wait rejects when the scroller never comes to rest.
 */
async function armScrollEnd(
  appUnderTest: AppUnderTest,
  scroller: Locator,
): Promise<() => Promise<void>> {
  // Wrapped in an object, because a handle to a promise would wait for it to settle.
  const armed = await scroller.evaluateHandle(
    (element, timeoutMs: number) => ({
      settled: new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("the scroller never came to rest after the gesture"));
        }, timeoutMs);
        element.addEventListener(
          "scrollend",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
    }),
    appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  );
  return async () => {
    await armed.evaluate(async (scrollEnd) => {
      await scrollEnd.settled;
    });
    await armed.dispose();
  };
}

/** Turns the wheel a notch at a time over the resting pointer, and waits for the scroll to end. */
async function wheelNotches(
  appUnderTest: AppUnderTest,
  scroller: Locator,
  direction: number,
): Promise<void> {
  for (let notch = 1; notch < WHEEL_NOTCH_COUNT; notch += 1) {
    await appUnderTest.window.mouse.wheel(0, direction * WHEEL_NOTCH_PX);
    await appUnderTest.window.evaluate(
      async (frameCount: number) =>
        await new Promise<void>((resolve) => {
          let framesLeft = frameCount;
          const onFrame = (): void => {
            framesLeft -= 1;
            if (framesLeft === 0) {
              resolve();
              return;
            }
            requestAnimationFrame(onFrame);
          };
          requestAnimationFrame(onFrame);
        }),
      FRAMES_BETWEEN_WHEEL_NOTCHES,
    );
  }
  // Each notch's smooth scroll runs into the next, so the scroll ends once, after the last.
  const waitForScrollEnd = await armScrollEnd(appUnderTest, scroller);
  await appUnderTest.window.mouse.wheel(0, direction * WHEEL_NOTCH_PX);
  await waitForScrollEnd();
}

/** Ends the trace and reads it back whole. */
async function endTracing(cdpSession: CDPSession): Promise<string> {
  const completed = new Promise<string | undefined>((resolve) => {
    cdpSession.once("Tracing.tracingComplete", (event) => {
      resolve(event.stream);
    });
  });
  await cdpSession.send("Tracing.end");
  const stream = await completed;
  if (stream === undefined) {
    throw new Error("the trace ended without a stream to read it from");
  }
  let text = "";
  for (;;) {
    const chunk = await cdpSession.send("IO.read", { handle: stream });
    text += chunk.data;
    if (chunk.eof) {
      break;
    }
  }
  await cdpSession.send("IO.close", { handle: stream });
  return text;
}

/** The trace's records, with every 64-bit id kept as its source text. */
function parseTrace(text: string): readonly TraceEvent[] {
  const trace = JSON.parse(text, (member: string, value: unknown, context?: { source?: string }) =>
    TRACE_ID_MEMBERS.has(member) ? context?.source : value,
  ) as { readonly traceEvents: readonly TraceEvent[] };
  return trace.traceEvents;
}

/** The two readings, from the records of the renderer the gesture scrolled. */
function readScrollTrace(events: readonly TraceEvent[]): ScrollReading {
  const latencies = pairSpans(events, "EventLatency");
  const scrollBegin = latencies.find(
    (span) => latencyOf(span.begin)["event_type"] === "GESTURE_SCROLL_BEGIN",
  );
  if (scrollBegin === undefined) {
    throw new Error("no scroll gesture reached the window in the trace");
  }
  const rendererPid = scrollBegin.begin.pid;
  // An update's stages share its async id and sit inside its span; ids are reused, so a stage is
  // matched by id and by falling inside the span.
  const stageTimesByKey = new Map<string, StageTimes>();
  const damageByResultId = new Map<string, string>();
  for (const event of events) {
    if (event.pid !== rendererPid) {
      continue;
    }
    const isArrival = event.name === "BrowserMainToRendererCompositor" && event.ph === "e";
    const isSubmit =
      event.name === "SubmitCompositorFrameToPresentationCompositorFrame" && event.ph === "b";
    if (isArrival || isSubmit) {
      const stages = stageTimesByKey.get(spanKey(event)) ?? { arrivedUs: [], submittedUs: [] };
      (isArrival ? stages.arrivedUs : stages.submittedUs).push(event.ts);
      stageTimesByKey.set(spanKey(event), stages);
    }
    if (event.name === "ScrollJankV4" && event.ph === "b") {
      const result = recordOf(event, "scroll_jank_v4");
      damageByResultId.set(String(result["result_id"]), String(result["damage_type"]));
    }
  }

  // A wheel turn or a touch move reaches the window before the update the browser makes from it,
  // which the browser sends only once the window has let the input through. The two share the
  // person's time stamp, so the earliest arrival among records stamped alike is the input's.
  const inputArrivalByStamp = new Map<number, number>();
  for (const { begin, end } of latencies) {
    const arrivedUs = arrivalWithin(stageTimesByKey, begin, end);
    if (begin.pid === rendererPid && arrivedUs !== undefined) {
      inputArrivalByStamp.set(
        begin.ts,
        Math.min(inputArrivalByStamp.get(begin.ts) ?? arrivedUs, arrivedUs),
      );
    }
  }

  // A frame the main thread finished late has two reports, one for the frame the compositor drew
  // on its own and one for the main thread's; each is its own submitted frame.
  const frames: SubmittedFrame[] = [];
  const frameByDisplayTraceId = new Map<string, SubmittedFrame>();
  for (const { begin, end } of pairSpans(events, "PipelineReporter")) {
    const report = recordOf(begin, "frame_reporter");
    const submittedUs = stageTimesByKey
      .get(spanKey(begin))
      ?.submittedUs.find((atUs) => atUs >= begin.ts && atUs <= end.ts);
    if (begin.pid !== rendererPid || report["display_trace_id"] === undefined) {
      continue;
    }
    if (submittedUs === undefined) {
      throw new Error("a frame report carries a display id and no submit");
    }
    const frame: SubmittedFrame = {
      submittedUs,
      presentedAtUs: PRESENTED_FRAME_STATES.has(String(report["state"])) ? end.ts : undefined,
    };
    frames.push(frame);
    frameByDisplayTraceId.set(String(report["display_trace_id"]), frame);
  }

  const undrawnUpdates: string[] = [];
  const inputToSubmits: InputToSubmit[] = [];
  const drawnPresentationsUs: number[] = [];
  let refreshIntervalMs: number | undefined;
  let movingUpdateCount = 0;
  let stillUpdateCount = 0;
  for (const { begin } of latencies) {
    const latency = latencyOf(begin);
    const updateType = String(latency["event_type"]);
    if (begin.pid !== rendererPid || !SCROLL_UPDATE_TYPES.has(updateType)) {
      continue;
    }
    refreshIntervalMs ??= latency["vsync_interval_ms"] as number | undefined;
    const resultId = recordOf(begin, "scroll_jank_v4")["result_id"];
    if (resultId === undefined || damageByResultId.get(String(resultId)) !== MOVING_DAMAGE_TYPE) {
      stillUpdateCount += 1;
      continue;
    }
    movingUpdateCount += 1;
    const inputArrivedUs = inputArrivalByStamp.get(begin.ts);
    const update = `${updateType} ${((begin.ts - scrollBegin.begin.ts) / 1000).toFixed(1)} ms in`;
    const drawingFrame = frameByDisplayTraceId.get(String(latency["display_trace_id"]));
    if (inputArrivedUs === undefined || drawingFrame?.presentedAtUs === undefined) {
      undrawnUpdates.push(update);
      continue;
    }
    inputToSubmits.push({
      update,
      durationMs: (drawingFrame.submittedUs - inputArrivedUs) / 1000,
    });
    drawnPresentationsUs.push(drawingFrame.presentedAtUs);
  }
  if (refreshIntervalMs === undefined || inputToSubmits.length === 0) {
    throw new Error("no scroll update in the trace moved the content");
  }

  const firstDrawnUs = Math.min(...drawnPresentationsUs);
  const lastDrawnUs = Math.max(...drawnPresentationsUs);
  const presentationsUs = [
    ...new Set(
      frames
        .map((frame) => frame.presentedAtUs)
        .filter(
          (atUs): atUs is number =>
            atUs !== undefined && atUs >= firstDrawnUs && atUs <= lastDrawnUs,
        ),
    ),
  ].sort((left, right) => left - right);
  const presentedFrameGapsMs = presentationsUs
    .slice(1)
    .map((atUs, index) => (atUs - (presentationsUs[index] ?? atUs)) / 1000);
  if (presentedFrameGapsMs.length === 0) {
    throw new Error("the gesture moved the content in a single presented frame");
  }
  return {
    refreshIntervalMs,
    presentedFrameGapsMs,
    movingUpdateCount,
    stillUpdateCount,
    undrawnUpdates,
    slowestInputToSubmit: slowestOf(inputToSubmits),
  };
}

/** The longest of several waits; throws on none, since a reading always has one. */
function slowestOf(waits: readonly InputToSubmit[]): InputToSubmit {
  const [first, ...rest] = waits;
  if (first === undefined) {
    throw new Error("there is no wait to take the slowest of");
  }
  return rest.reduce(
    (slowest, candidate) => (candidate.durationMs > slowest.durationMs ? candidate : slowest),
    first,
  );
}

/** When the input or update a latency record follows reached the window, if the trace has it. */
function arrivalWithin(
  stageTimesByKey: ReadonlyMap<string, StageTimes>,
  begin: TraceEvent,
  end: TraceEvent,
): number | undefined {
  return stageTimesByKey
    .get(spanKey(begin))
    ?.arrivedUs.find((atUs) => atUs >= begin.ts && atUs <= end.ts);
}

/** Pairs each named async record's start with its end, by process and async id. */
function pairSpans(events: readonly TraceEvent[], name: string): readonly TraceSpan[] {
  const openByKey = new Map<string, TraceEvent>();
  const spans: TraceSpan[] = [];
  const named = events
    .filter((event) => event.name === name)
    .sort((left, right) => left.ts - right.ts);
  for (const event of named) {
    if (event.ph === "b") {
      openByKey.set(spanKey(event), event);
      continue;
    }
    const begin = openByKey.get(spanKey(event));
    if (event.ph === "e" && begin !== undefined) {
      openByKey.delete(spanKey(event));
      spans.push({ begin, end: event });
    }
  }
  return spans;
}

function spanKey(event: TraceEvent): string {
  return `${String(event.pid)}:${event.id2?.local ?? event.id ?? ""}`;
}

/** One named record in an event's arguments, or an empty one where the event carries none. */
function recordOf(event: TraceEvent, member: string): Record<string, unknown> {
  return (event.args?.[member] as Record<string, unknown> | undefined) ?? {};
}

function latencyOf(event: TraceEvent): Record<string, unknown> {
  return recordOf(event, "event_latency");
}
