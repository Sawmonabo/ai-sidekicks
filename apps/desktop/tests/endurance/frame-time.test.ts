// The four-lane frame-time budget: the median of three warm launches' 95th-percentile frame
// duration while four agent lanes stream into the transcript, in refreshes of the display the run
// drew on, compared through the registry's own `evaluateBudget`. The cold launch before them is
// printed on its own as the first-launch figure (`frame-sampling.ts` says why).
//
// A frame's duration is the main-thread work it costs, not the interval between frames: the
// interval between animation-frame callbacks is the display's refresh period, so its p95 could
// never be under one refresh. The p50 is printed beside the p95 to show which of the two is being
// reported. The sampler and the workload check are `frame-sampling.ts`'s; the refresh is the vsync
// interval the window's compositor recorded in a trace taken over the same frames
// (`trace/refresh.ts`).
//
// The comparison gates only on the pinned runner class (`pinned-runner-class.ts`); elsewhere
// the figure is printed so the instrument still runs. The negative control is not pinned:
// whether the instrument tells a stalled frame from a healthy one holds on every machine.
//
// The sampled window holds the concurrent-streaming scenario: four runs mid-turn at the same
// tick, one blocked on an approval. The run asserts the script delivered inside the window and
// that four lanes streamed in it (`streaming-lanes.ts`). Revealed text is not measured: the
// scripted beats carry each body's description, not the body, and the reveal engine has its
// own row, `streaming-cpu-one-lane`. Long tasks and the overlay scrollbars started by the window's
// end are printed beside the figure, so the overlay's cost reads off the same run.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron/harness.js";
import { readOverlayScrollbars } from "./overlay-scrollbar/instances.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { percentileByNearestRank } from "../helpers/sample-statistics.js";
import { ENDURANCE_LAUNCH_OPTIONS, openConcurrentStreamingSessionRoute } from "./workload.js";
import { RUNNER_CLASS_DESCRIPTION, gateOnPinnedRunner } from "./pinned-runner-class.js";
import {
  MEASURED_RUN_COUNT,
  expectFourLaneWorkloadInsideWindow,
  measureLaunches,
  sampleFrameTimings,
  type FrameTimingRun,
} from "./frame-sampling.js";
import { endTraceRecording, startTraceRecording } from "./trace/recording.js";
import { readRefreshIntervalMs } from "./trace/refresh.js";
import { BudgetRegistry } from "../helpers/budget/registry.js";
import { evaluateBudget } from "../helpers/budget/evaluation.js";

const bundleIsBuilt = fixtureBundleExists();

/** The budget row this file measures. */
const FRAME_TIME_BUDGET_ID = "frame-time-p95-four-lanes";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(FRAME_TIME_BUDGET_ID);

/** The category whose begin-frame records carry the display's vsync interval. */
const REFRESH_TRACE_CATEGORIES: readonly string[] = ["benchmark"];

/** The shortest task the browser reports as a long task, in milliseconds. */
const LONG_TASK_THRESHOLD_MS = 50;

/**
 * The per-frame stall the negative control plants, in milliseconds: synchronous inside the frame's
 * callback, and past the long-task threshold by a fifth, so each stalled frame is also a long task
 * and lasts several refreshes of any display a reading is taken on.
 */
const PLANTED_FRAME_STALL_MS: number = Math.ceil(LONG_TASK_THRESHOLD_MS * 1.2);

/** One sampled launch, the refresh it drew at, and the overlay scrollbars it had started. */
interface MeasuredRun extends FrameTimingRun {
  /** One refresh of the display the window drew on, in milliseconds. */
  readonly refreshIntervalMs: number;
  readonly startedOverlayScrollbarCount: number;
}

/** One launch, opened on the concurrent-streaming session and sampled under a trace. */
async function runOnce(plantedStallMilliseconds: number): Promise<MeasuredRun> {
  return await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
    await openConcurrentStreamingSessionRoute(appUnderTest);
    const cdpSession = await appUnderTest.application.context().newCDPSession(appUnderTest.window);
    await startTraceRecording(cdpSession, REFRESH_TRACE_CATEGORIES);
    const run = await sampleFrameTimings(appUnderTest, plantedStallMilliseconds);
    const refreshIntervalMs = readRefreshIntervalMs(await endTraceRecording(cdpSession));
    const census = await readOverlayScrollbars(appUnderTest);
    return { ...run, refreshIntervalMs, startedOverlayScrollbarCount: census.startedHosts.length };
  });
}

/** Sums a run's long tasks, in milliseconds. */
function totalMilliseconds(durationsMs: readonly number[]): number {
  return durationsMs.reduce((total, duration) => total + duration, 0);
}

/** A run's 95th-percentile frame duration, in refreshes of the display it drew on. */
function p95InRefreshes(run: MeasuredRun): number {
  return percentileByNearestRank(run.frameDurationsMs, 0.95) / run.refreshIntervalMs;
}

function describeRunLoad(run: MeasuredRun): string {
  return (
    `${String(run.longTaskDurationsMs.length)} long tasks ` +
    `(${totalMilliseconds(run.longTaskDurationsMs).toFixed(0)} ms), ` +
    `${String(run.startedOverlayScrollbarCount)} overlay scrollbars started, ` +
    `one refresh ${run.refreshIntervalMs.toFixed(3)} ms`
  );
}

describe.skipIf(!bundleIsBuilt)(
  "endurance — frame time with the concurrent-streaming session open",
  () => {
    it("holds the 95th-percentile frame duration under the budget's ceiling", async () => {
      const { firstLaunch, warmLaunches } = await measureLaunches(async () => {
        const run = await runOnce(0);
        expectFourLaneWorkloadInsideWindow(run);
        return run;
      });
      const perRunPercentiles = warmLaunches.map(p95InRefreshes);
      const perRunMedians = warmLaunches.map((run) =>
        percentileByNearestRank(run.frameDurationsMs, 0.5),
      );
      const measuredP95 = percentileByNearestRank(perRunPercentiles, 0.5);
      const verdict = evaluateBudget(budget, measuredP95);

      // Printed before the assertion on every machine, so a shrinking margin shows before a
      // run crosses. The p50 tells the readings apart: one at the display's cadence would mean
      // the instrument reports how often frames arrive.
      process.stdout.write(
        `[endurance] frame time p95 ${measuredP95.toFixed(3)} refreshes ` +
          `(median of ${String(MEASURED_RUN_COUNT)} warm launches: ` +
          `${perRunPercentiles.map((value) => value.toFixed(3)).join(", ")}) ` +
          `of a ${String(budget.limit.canonicalValue)} refresh ceiling ` +
          `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
          `p50 ${percentileByNearestRank(perRunMedians, 0.5).toFixed(2)} ms ` +
          `(${perRunMedians.map((value) => value.toFixed(2)).join(", ")}); ` +
          `${warmLaunches.map(describeRunLoad).join("; ")} — ${RUNNER_CLASS_DESCRIPTION}\n`,
      );
      process.stdout.write(
        `[endurance] frame time first launch, cold GPU caches, not gated: p95 ` +
          `${p95InRefreshes(firstLaunch).toFixed(3)} refreshes; p50 ` +
          `${percentileByNearestRank(firstLaunch.frameDurationsMs, 0.5).toFixed(2)} ms; ` +
          `${describeRunLoad(firstLaunch)} — ${RUNNER_CLASS_DESCRIPTION}\n`,
      );

      gateOnPinnedRunner(
        verdict,
        `${budget.label}: ${measuredP95.toFixed(3)} refreshes against a ` +
          `${String(budget.limit.canonicalValue)} refresh ceiling`,
      );
    });

    it("negative control: a planted frame stall crosses the same ceiling", async () => {
      // Without this the case above would pass over an instrument that reported a constant or
      // sampled nothing, and off the pinned class nothing asserts the figure at all. The stall
      // is synchronous work in each frame's callback through the same sampler.
      const run = await runOnce(PLANTED_FRAME_STALL_MS);
      const stalledP95Ms = percentileByNearestRank(run.frameDurationsMs, 0.95);
      const stalledP95 = stalledP95Ms / run.refreshIntervalMs;
      process.stdout.write(
        `[endurance] frame time p95 under a planted ${String(PLANTED_FRAME_STALL_MS)} ms ` +
          `per-frame stall: ${stalledP95.toFixed(3)} refreshes, ${stalledP95Ms.toFixed(2)} ms; ` +
          `${String(run.longTaskDurationsMs.length)} long tasks\n`,
      );

      expect(stalledP95Ms).toBeGreaterThan(PLANTED_FRAME_STALL_MS);
      // The long tasks printed beside the healthy figure are read by the same observers, so a
      // stall they miss would make that zero meaningless.
      expect(run.longTaskDurationsMs.length).toBeGreaterThan(0);
      expect(
        evaluateBudget(budget, stalledP95).withinBudget,
        "a renderer holding its main thread for several refreshes every frame passed this " +
          "budget, so the gate would report green over the one failure it exists to catch",
      ).toBe(false);
    });
  },
);
