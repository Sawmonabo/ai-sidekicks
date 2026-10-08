// The scrolling budgets: a fling with its momentum and a wheel scroll on each scroller but the
// conversation, while four agent lanes stream, read from the window's own frame and input records
// in a DevTools trace (`../trace/scroll.ts`); the conversation's own budgets are
// `conversation.test.ts`'s. The fling is a touch drag let go at speed, the one fling
// the DevTools protocol can make; its momentum reaches the window as the browser's inertial scroll
// updates. The wheel scroll is notches turned several frames apart.
//
// Each trace gives three readings, every one in refreshes of the display the trace was taken on.
// The gaps between the frames the window presented while a fling moved the content: one refresh
// each when no frame is missed. For each update that moved the content, the time from its input
// reaching the window to the submit of the frame that drew it: within two refreshes it was drawn in
// the first frame after the input, since an input that arrives just after a frame began waits at
// most a refresh for the next one, which submits within the refresh after. And whether each
// gesture's scroller was found by the compositor's own hit test, or waited for the main thread to
// find it, as it does under a rounded clip.
//
// The two timed readings are hardware-dependent, so they gate on the pinned runner class
// (`../pinned-runner-class.ts`) and are printed everywhere else; where a scroll is hit-tested is not a
// timing and holds on every machine. The controls hold on every machine too: draw heavier than a
// refresh misses frames, a wheel handler that holds each turn crosses the input ceiling, and a pane
// that clips its rounded corners hands each scroll's hit test to the main thread.
//
// Every run is a fresh launch, because the scenario's frozen clock does not rewind. The frame-time
// sampler (`../frame-sampling.ts`) drives the script one step per frame, and each gesture starts
// once four lanes are mid-turn (`../streaming-lanes.ts`).

import process from "node:process";

import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { openPalette } from "../../helpers/palette-interaction.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../../helpers/launch/body.js";
import { percentileByNearestRank } from "../../helpers/sample-statistics.js";
import { MEASURED_RUN_COUNT, sampleFrameTimings } from "../frame-sampling.js";
import { RUNNER_CLASS_DESCRIPTION, isPinnedRunnerClass } from "../pinned-runner-class.js";
import { findStreamingStretch, peakConcurrentStreamingRuns } from "../streaming-lanes.js";
import { endTraceRecording, startTraceRecording } from "../trace/recording.js";
import {
  SCROLL_TRACE_CATEGORIES,
  readScrollTrace,
  slowestOf,
  type InputToSubmit,
  type ScrollReading,
} from "../trace/scroll.js";
import {
  ENDURANCE_LAUNCH_OPTIONS,
  advanceScenario,
  openConcurrentStreamingSessionRoute,
  openRoute,
  readDeliveredBeatCount,
  waitForDeliveredBeats,
  waitForIdleWindow,
} from "../workload.js";
import { BLURRING_LAYER_COUNT, plant, type Plant } from "./planted-regressions.js";
import { formatRoute } from "#renderer/routing/routes.js";
import {
  CONCURRENT_STREAMING_LANE_COUNT,
  CONCURRENT_STREAMING_SCENARIO,
} from "#fixtures/scenarios/concurrent-streaming.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";

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

/** What one launch measured over one gesture. */
interface ScrollRun {
  readonly reading: ScrollReading;
  readonly beatsAtGestureStart: number;
  readonly beatsAtGestureEnd: number;
  /** Whether the sampler was still driving the script when the gesture came to rest. */
  readonly didSamplingOutlastGesture: boolean;
}

/** The fling's drag, in pixels a second: a quick flick, whose momentum carries on past the drag. */
const FLING_SPEED_PX_PER_SECOND = 3000;

/** The share of the scroll range the fling drags; its momentum carries the rest of the travel. */
const FLING_DRAG_SHARE_OF_RANGE = 0.3;

/**
 * The most wheel notches turned; a shorter scroller takes as many as fit its travel, since a notch
 * turned at its end moves nothing and never ends a scroll.
 */
const MAX_WHEEL_NOTCH_COUNT = 10;

/** One wheel notch, in pixels. */
const WHEEL_NOTCH_PX = 100;

/** Frames between wheel notches: a notch a person turns, not a burst the browser merges. */
const FRAMES_BETWEEN_WHEEL_NOTCHES = 10;

/** Lines typed into the draft: several times what its box shows before it scrolls. */
const DRAFT_LINE_COUNT = 80;

/** How far each poll moves the clock while a screen waits on a scripted read. */
const CLOCK_STEP_MS = 50;

/**
 * One refresh of the slowest display a reading here is taken on, in milliseconds: the pinned
 * runner's Xvfb display refreshes at 60 Hz.
 */
const SLOWEST_DISPLAY_REFRESH_MS = 1000 / 60;

/**
 * How long the planted wheel handler holds the main thread: half as long again as the input
 * ceiling on the slowest display, so the control crosses that ceiling on any display.
 */
const WHEEL_HOLD_MS = Math.ceil(
  inputToFrameBudget.limit.canonicalValue * SLOWEST_DISPLAY_REFRESH_MS * 1.5,
);

/** The delivered-beat count at which four lanes first stream at once. */
const FOUR_LANE_BEAT_COUNT: number = findStreamingStretch(
  CONCURRENT_STREAMING_SCENARIO.beats,
  CONCURRENT_STREAMING_LANE_COUNT,
).fromBeatCount;

const SCREEN_REGION: ScrollHost = {
  name: "the screen region on Settings › Keyboard",
  scrollerSelector: ".meridian-frame__screen",
  open: async (appUnderTest) => {
    // The keyboard page's list is the settings page that runs longest. The session screen's own
    // region never overflows, its panes scrolling inside it, so the screen region is measured
    // here, with the streaming session open in the store but not on screen; the other hosts
    // scroll over the streaming session.
    await openRoute(
      appUnderTest,
      formatRoute({ kind: "settings", page: "keyboard" }),
      ".meridian-frame__screen .meridian-keymap",
    );
  },
};

const DIFF_PANE: ScrollHost = {
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
};

const SCROLL_HOSTS: readonly ScrollHost[] = [
  SCREEN_REGION,
  {
    name: "the draft box",
    scrollerSelector: ".meridian-composer .meridian-text-box__scroller",
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
  DIFF_PANE,
  {
    name: "the command palette's list",
    scrollerSelector: ".command-palette__list",
    open: async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      await openPalette(appUnderTest);
    },
  },
];

describe.skipIf(!bundleIsBuilt)(
  "endurance — scrolling with the concurrent-streaming session open",
  () => {
    for (const host of SCROLL_HOSTS) {
      it(`${host.name}: a frame each refresh through a fling, each input in the first frame after it, each scroller found on the compositor`, async () => {
        const flingGapPercentiles: number[] = [];
        const undrawnUpdates: string[] = [];
        const mainThreadHitTests: string[] = [];
        const slowestInputToSubmitByRun: InputToSubmit[] = [];
        const refreshIntervalsMs = new Set<string>();
        const runSummaries: string[] = [];
        for (const gesture of SCROLL_GESTURES) {
          for (let runIndex = 1; runIndex <= MEASURED_RUN_COUNT; runIndex += 1) {
            const run = await scrollOnce(host, gesture, undefined);
            const label = `${host.name}, ${gesture} ${String(runIndex)}`;
            expectFourLanesThroughGesture(run, label);
            const { reading } = run;
            refreshIntervalsMs.add(reading.refreshIntervalMs.toFixed(3));
            if (gesture === "fling") {
              flingGapPercentiles.push(
                percentileByNearestRank(reading.presentedFrameGapsInRefreshes, 0.95),
              );
            }
            undrawnUpdates.push(...reading.undrawnUpdates.map((update) => `${label}: ${update}`));
            mainThreadHitTests.push(...describeMainThreadHitTests(reading, label));
            slowestInputToSubmitByRun.push({
              ...reading.slowestInputToSubmit,
              update: `${label}: ${reading.slowestInputToSubmit.update}`,
            });
            runSummaries.push(
              `${gesture} ${String(runIndex)}: ${String(reading.movingUpdateCount)} moving, ` +
                `${String(reading.stillUpdateCount)} still, ` +
                `${String(reading.mainThreadMissedFrameCount)} of ` +
                `${String(reading.presentedFrameCount)} frames without the main thread's update, ` +
                `${String(reading.gestureCount - reading.mainThreadHitTestCount)} of ` +
                `${String(reading.gestureCount)} gestures found on the compositor, input to ` +
                `submit up to ${reading.slowestInputToSubmit.durationMs.toFixed(2)} ms`,
            );
          }
        }
        const flingGapP95 = percentileByNearestRank(flingGapPercentiles, 0.5);
        const slowestInputToSubmit = slowestOf(slowestInputToSubmitByRun);
        const frameGapVerdict = evaluateBudget(frameGapBudget, flingGapP95);
        const inputVerdict = evaluateBudget(inputToFrameBudget, slowestInputToSubmit.refreshes);

        process.stdout.write(
          `[endurance] scrolling ${host.name}: presented-frame gap p95 through a fling ` +
            `${String(flingGapP95)} refreshes (median of ${String(MEASURED_RUN_COUNT)} runs: ` +
            `${flingGapPercentiles.join(", ")}) of a ` +
            `${String(frameGapBudget.limit.canonicalValue)} refresh ceiling ` +
            `(${(frameGapVerdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
            `slowest input to submit ${slowestInputToSubmit.refreshes.toFixed(2)} refreshes, ` +
            `${slowestInputToSubmit.durationMs.toFixed(2)} ms (${slowestInputToSubmit.update}) ` +
            `of a ${String(inputToFrameBudget.limit.canonicalValue)} refresh ceiling ` +
            `(${(inputVerdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
            `${runSummaries.join("; ")}; one refresh is ${[...refreshIntervalsMs].join(" or ")} ` +
            `ms — ${RUNNER_CLASS_DESCRIPTION}\n`,
        );

        // Not a timing: whether the compositor finds a scroller depends on how it is painted, on
        // every machine.
        expect(
          mainThreadHitTests,
          `${frameGapBudget.label}: gestures on ${host.name} whose scroller the compositor could ` +
            "not find on its own, so each waited for the main thread before it moved",
        ).toStrictEqual([]);
        if (!isPinnedRunnerClass) {
          // Not a skip: the instrument ran and the figures are printed. Only the timed
          // comparisons are withheld, because frame cost off the pinned class describes that
          // machine.
          return;
        }
        expect(
          frameGapVerdict.withinBudget,
          `${frameGapBudget.label}: ${host.name}'s fling presented frames ` +
            `${String(flingGapP95)} refreshes apart at the 95th percentile, against a ` +
            `${String(frameGapBudget.limit.canonicalValue)} refresh ceiling`,
        ).toBe(true);
        expect(
          inputVerdict.withinBudget,
          `${inputToFrameBudget.label}: ${slowestInputToSubmit.update} waited ` +
            `${slowestInputToSubmit.refreshes.toFixed(2)} refreshes from its input reaching ` +
            `the window to its frame's submit, against a ` +
            `${String(inputToFrameBudget.limit.canonicalValue)} refresh ceiling`,
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
      const heavyGapP95 = percentileByNearestRank(reading.presentedFrameGapsInRefreshes, 0.95);
      process.stdout.write(
        `[endurance] scrolling under ${String(BLURRING_LAYER_COUNT)} blurring layers: ` +
          `presented-frame gap p95 ${String(heavyGapP95)} refreshes of ` +
          `${reading.refreshIntervalMs.toFixed(3)} ms, ` +
          `${String(reading.movingUpdateCount)} moving updates\n`,
      );

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
          `${slowestInputToSubmit.refreshes.toFixed(2)} refreshes, ` +
          `${slowestInputToSubmit.durationMs.toFixed(2)} ms (${slowestInputToSubmit.update})\n`,
      );

      expect(
        evaluateBudget(inputToFrameBudget, slowestInputToSubmit.refreshes).withinBudget,
        "a wheel scroll whose handler held each turn for several refreshes passed the input " +
          "ceiling, so the reading would report green over the wait it exists to catch",
      ).toBe(false);
    });

    it("negative control: a pane that clips its rounded corners hands each scroll's hit test to the main thread", async () => {
      // Without this the hit-test clause could pass over a reader that never saw the main
      // thread asked, whatever the pane clipped.
      const { reading } = await scrollOnce(DIFF_PANE, "fling", { kind: "rounded-pane-clip" });
      process.stdout.write(
        `[endurance] scrolling a pane that clips its rounded corners: ` +
          `${String(reading.mainThreadHitTestCount)} of ${String(reading.gestureCount)} ` +
          "gestures hit-tested on the main thread\n",
      );

      expect(
        describeMainThreadHitTests(reading, "the diff pane under a rounded clip"),
        "a fling on a scroller under a rounded clip passed the hit-test clause, so the clause " +
          "would report green over the main-thread wait it exists to catch",
      ).not.toStrictEqual([]);
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
    await startTraceRecording(cdpSession, SCROLL_TRACE_CATEGORIES);
    const samplingEnd = sampleFrameTimings(appUnderTest, 0).then(() => performance.now());
    await waitForDeliveredBeats(appUnderTest, FOUR_LANE_BEAT_COUNT);
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
      const travel = direction === 1 ? geometry.range - geometry.offset : geometry.offset;
      const notchCount = Math.max(
        1,
        Math.min(MAX_WHEEL_NOTCH_COUNT, Math.floor(travel / WHEEL_NOTCH_PX)),
      );
      await wheelNotches(appUnderTest, scroller, direction, notchCount);
    }
    const beatsAtGestureEnd = await readDeliveredBeatCount(appUnderTest);
    const gestureEndedAtMs = performance.now();
    const reading = readScrollTrace(await endTraceRecording(cdpSession));
    const samplingEndedAtMs = await samplingEnd;
    return {
      reading,
      beatsAtGestureStart,
      beatsAtGestureEnd,
      didSamplingOutlastGesture: samplingEndedAtMs > gestureEndedAtMs,
    };
  });
}

/** The failure line for a reading whose gestures waited for a main-thread hit test, or none. */
function describeMainThreadHitTests(reading: ScrollReading, label: string): readonly string[] {
  return reading.mainThreadHitTestCount === 0
    ? []
    : [
        `${label}: ${String(reading.mainThreadHitTestCount)} of ` +
          `${String(reading.gestureCount)} gestures hit-tested on the main thread`,
      ];
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
  notchCount: number,
): Promise<void> {
  for (let notch = 1; notch < notchCount; notch += 1) {
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
