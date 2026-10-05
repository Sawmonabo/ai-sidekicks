// The four-lane frame-time budget: the median of three runs' 95th-percentile frame duration
// while four agent lanes stream into the transcript, compared through the registry's own
// `evaluateBudget`.
//
// A frame's duration is the main-thread work it costs, not the interval between frames. The
// interval between animation-frame callbacks is the display's refresh period (~16.7 ms at 60 Hz,
// as on the pinned runner's Xvfb source), so its p95 could never be under a 16.7 ms ceiling.
// The p50 is printed beside the p95 to show which of the two is being reported.
//
// A sample runs from the start of a frame's animation-frame callback to the first task after
// that frame's rendering: a `MessageChannel` message posted from the callback is a task, and
// the event loop cannot select one until the rendering update it is in has finished.
// `setTimeout(0)` is not used because its clamped timeout would be added to every reading.
//
// The comparison gates only on the pinned runner class (`pinned-runner-class.ts`); elsewhere
// the figure is printed so the instrument still runs. The negative control is not pinned:
// whether the instrument tells a stalled frame from a healthy one holds on every machine.
//
// The sampled window holds the concurrent-streaming scenario: four runs mid-turn at the same
// tick, one blocked on an approval. The run asserts the script delivered inside the window and
// that four lanes streamed in it (`streaming-lanes.ts`). Revealed text is not measured: the
// scripted beats carry each body's description, not the body, and the reveal engine has its
// own row, `streaming-cpu-one-lane`.
//
// The warm-up is a frame count, not the protocol's ten seconds: the frozen clock only moves
// when this file moves it, so ten seconds of frames would deliver the whole script before the
// first sample. The advance per frame is derived from the script's span, as `steady-state.test.ts`
// does.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { percentileByNearestRank } from "../helpers/sample-statistics.js";
import { SCENARIO_FIXTURE_GLOBAL } from "@renderer/app/fixture-global-names.js";
import {
  ENDURANCE_LAUNCH_OPTIONS,
  openConcurrentStreamingSessionRoute,
} from "./endurance-workload.js";
import { RUNNER_CLASS_DESCRIPTION, isPinnedRunnerClass } from "./pinned-runner-class.js";
import {
  CONCURRENT_STREAMING_LANE_COUNT,
  CONCURRENT_STREAMING_SCENARIO,
} from "../../fixtures/scenarios/concurrent-streaming.js";
import { peakConcurrentStreamingRuns } from "./streaming-lanes.js";
import { BudgetRegistry } from "../../scripts/budget/budget-registry.mts";
import { evaluateBudget } from "../../scripts/budget/budget-evaluation.mts";

const bundleIsBuilt = fixtureBundleExists();

/** The budget row this file measures. */
const FRAME_TIME_BUDGET_ID = "frame-time-p95-four-lanes";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(FRAME_TIME_BUDGET_ID);

/**
 * How many frame durations one run samples.
 *
 * Three hundred puts the 95th percentile at the fifteenth-slowest frame, so one hiccup moves it
 * by a rank rather than deciding it.
 */
const SAMPLED_FRAME_COUNT = 300;

/**
 * Frames discarded before sampling starts.
 *
 * The first frames after a mount carry the virtualizer's initial measurement pass and V8
 * compilation, which the budget does not bound. A frame count, not seconds; see the header.
 */
const WARM_UP_FRAME_COUNT = 30;

/**
 * How many fresh launches the reported figure is the median of.
 *
 * Each is its own launch because the frozen clock does not rewind: repeat passes in one window
 * would measure an app whose script was already delivered.
 */
const MEASURED_RUN_COUNT = 3;

/**
 * The per-frame stall the negative control plants, in milliseconds: twice the row's ceiling and
 * synchronous inside the frame's callback, so the verdict does not depend on the display's cadence.
 */
const PLANTED_FRAME_STALL_MS: number = Math.ceil(budget.limit.canonicalValue * 2);

/** What one sampled run measured. */
interface FrameTimingRun {
  readonly frameDurationsMs: readonly number[];
  readonly beatsAtWindowStart: number;
  readonly beatsAtWindowEnd: number;
}

/**
 * Samples frame durations while the concurrent-streaming script delivers into the open session.
 *
 * The loop runs inside the renderer because a driver round trip per frame would dwarf the
 * durations measured. A frame is opened by `requestAnimationFrame` and closed by the message
 * the callback posts to itself; the next frame is requested from the closing side, so only one
 * measurement is ever open.
 */
async function sampleFrameTimings(
  appUnderTest: AppUnderTest,
  plantedStallMilliseconds: number,
): Promise<FrameTimingRun | null> {
  const scriptSpanMs = CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0;
  const advanceMillisecondsPerFrame = Math.max(1, Math.ceil(scriptSpanMs / SAMPLED_FRAME_COUNT));
  return appUnderTest.window.evaluate(
    async ([
      scenarioGlobalName,
      warmUpFrames,
      sampledFrames,
      advanceMilliseconds,
      stallMilliseconds,
    ]: [string, number, number, number, number]) => {
      // The scenario's handle is the console document's, which opened this window.
      const scenarioControl = (
        (window.opener ?? globalThis) as unknown as Record<
          string,
          { advance(milliseconds: number): void; deliveredBeatCount(): number } | undefined
        >
      )[scenarioGlobalName];
      if (scenarioControl === undefined) {
        return null;
      }
      const frameDurationsMs: number[] = [];
      let beatsAtWindowStart = -1;
      await new Promise<void>((resolve) => {
        const afterFrame = new MessageChannel();
        let frameIndex = 0;
        let frameStartedAtMs = 0;
        const onFrame = (): void => {
          frameStartedAtMs = performance.now();
          if (frameIndex === warmUpFrames) {
            beatsAtWindowStart = scenarioControl.deliveredBeatCount();
          }
          scenarioControl.advance(advanceMilliseconds);
          if (stallMilliseconds > 0) {
            const stallUntil = performance.now() + stallMilliseconds;
            while (performance.now() < stallUntil) {
              /* hold the frame, the way a renderer over its budget does */
            }
          }
          afterFrame.port2.postMessage(0);
        };
        afterFrame.port1.onmessage = (): void => {
          if (frameIndex > warmUpFrames) {
            frameDurationsMs.push(performance.now() - frameStartedAtMs);
          }
          frameIndex += 1;
          if (frameDurationsMs.length >= sampledFrames) {
            afterFrame.port1.close();
            afterFrame.port2.close();
            resolve();
            return;
          }
          requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      });
      return {
        frameDurationsMs,
        beatsAtWindowStart,
        beatsAtWindowEnd: scenarioControl.deliveredBeatCount(),
      };
    },
    [
      SCENARIO_FIXTURE_GLOBAL,
      WARM_UP_FRAME_COUNT,
      SAMPLED_FRAME_COUNT,
      advanceMillisecondsPerFrame,
      plantedStallMilliseconds,
    ] as [string, number, number, number, number],
  );
}

/** One launch, opened on the concurrent-streaming session and sampled. */
async function runOnce(plantedStallMilliseconds: number): Promise<FrameTimingRun> {
  return await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
    await openConcurrentStreamingSessionRoute(appUnderTest);
    const run = await sampleFrameTimings(appUnderTest, plantedStallMilliseconds);
    if (run === null) {
      throw new Error(
        `${SCENARIO_FIXTURE_GLOBAL} is not exposed by ` +
          `this build, so no frame in it was driven by a ` +
          "scenario and every interval sampled would describe an idle window",
      );
    }
    expect(run.frameDurationsMs).toHaveLength(SAMPLED_FRAME_COUNT);
    return run;
  });
}

/**
 * Asserts the sampled window holds the workload the row names: the script finished inside it,
 * was still arriving during it, and four lanes streamed. The lane count comes from the
 * scenario's cast, so a stale literal cannot pass.
 */
function expectFourLaneWorkloadInsideWindow(run: FrameTimingRun): void {
  expect(
    run.beatsAtWindowEnd,
    "the concurrent-streaming script had not finished " +
      "delivering by the end of the sampled window, so the " +
      "reading describes an app the session never fully reached",
  ).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);
  expect(
    run.beatsAtWindowEnd,
    "every beat had already been delivered before sampling started, so these frames measured a " +
      "settled app rather than one with a session arriving in it",
  ).toBeGreaterThan(run.beatsAtWindowStart);
  expect(
    peakConcurrentStreamingRuns(
      CONCURRENT_STREAMING_SCENARIO.beats,
      run.beatsAtWindowStart,
      run.beatsAtWindowEnd,
    ),
    "fewer than four agent lanes were mid-turn at any point inside the sampled window, so this " +
      "figure bounds an app that was not doing the work the budget row names",
  ).toBe(CONCURRENT_STREAMING_LANE_COUNT);
}

describe.skipIf(!bundleIsBuilt)(
  "endurance — frame time with the concurrent-streaming session open",
  () => {
    it("holds the 95th-percentile frame duration under the budget's ceiling", async () => {
      const perRunPercentiles: number[] = [];
      const perRunMedians: number[] = [];
      for (let runIndex = 0; runIndex < MEASURED_RUN_COUNT; runIndex += 1) {
        const run = await runOnce(0);
        expectFourLaneWorkloadInsideWindow(run);
        perRunPercentiles.push(percentileByNearestRank(run.frameDurationsMs, 0.95));
        perRunMedians.push(percentileByNearestRank(run.frameDurationsMs, 0.5));
      }
      const measuredP95 = percentileByNearestRank(perRunPercentiles, 0.5);
      const verdict = evaluateBudget(budget, measuredP95);

      // Printed before the assertion on every machine, so a shrinking margin shows before a
      // run crosses. The p50 tells the readings apart: one at the display's cadence (~16.67 ms
      // at 60 Hz) would mean the instrument reports how often frames arrive.
      process.stdout.write(
        `[endurance] frame time p95 ${measuredP95.toFixed(2)} ms ` +
          `(median of ${String(MEASURED_RUN_COUNT)} runs: ` +
          `${perRunPercentiles.map((value) => value.toFixed(2)).join(", ")}) ` +
          `of a ${String(budget.limit.canonicalValue)} ms ceiling ` +
          `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
          `p50 ${percentileByNearestRank(perRunMedians, 0.5).toFixed(2)} ms ` +
          `(${perRunMedians.map((value) => value.toFixed(2)).join(", ")}) — ` +
          `${RUNNER_CLASS_DESCRIPTION}\n`,
      );

      if (!isPinnedRunnerClass) {
        // Not a skip: the instrument ran and the figure is printed. Only the comparison is
        // withheld, because frame cost off the pinned class describes that machine.
        return;
      }
      expect(
        verdict.withinBudget,
        `${budget.label}: ${measuredP95.toFixed(2)} ms against a ` +
          `${String(budget.limit.canonicalValue)} ms ceiling`,
      ).toBe(true);
    });

    it("negative control: a planted frame stall crosses the same ceiling", async () => {
      // Without this the case above would pass over an instrument that reported a constant or
      // sampled nothing, and off the pinned class nothing asserts the figure at all. The stall
      // is synchronous work in each frame's callback through the same sampler.
      const run = await runOnce(PLANTED_FRAME_STALL_MS);
      const stalledP95 = percentileByNearestRank(run.frameDurationsMs, 0.95);
      process.stdout.write(
        `[endurance] frame time p95 under a planted ${String(PLANTED_FRAME_STALL_MS)} ms ` +
          `per-frame stall: ${stalledP95.toFixed(2)} ms\n`,
      );

      expect(stalledP95).toBeGreaterThan(PLANTED_FRAME_STALL_MS);
      expect(
        evaluateBudget(budget, stalledP95).withinBudget,
        "a renderer holding its main thread for twice the frame budget every frame passed this " +
          "budget, so the gate would report green over the one failure it exists to catch",
      ).toBe(false);
    });
  },
);
