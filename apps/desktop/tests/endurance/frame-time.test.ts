// The four-lane frame-time budget: the median of three runs' 95th-percentile frame duration
// while four agent lanes stream into the transcript, compared through the registry's own
// `evaluateBudget`.
//
// A frame's duration is the main-thread work it costs, not the interval between frames. The
// interval between animation-frame callbacks is the display's refresh period (~16.7 ms at 60 Hz,
// as on the pinned runner's Xvfb source), so its p95 could never be under a 16.7 ms ceiling.
// The p50 is printed beside the p95 to show which of the two is being reported. The sampler and
// the workload check are `frame-sampling.ts`'s.
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
import { RUNNER_CLASS_DESCRIPTION, isPinnedRunnerClass } from "./pinned-runner-class.js";
import {
  expectFourLaneWorkloadInsideWindow,
  sampleFrameTimings,
  type FrameTimingRun,
} from "./frame-sampling.js";
import { BudgetRegistry } from "../helpers/budget/registry.js";
import { evaluateBudget } from "../helpers/budget/evaluation.js";

const bundleIsBuilt = fixtureBundleExists();

/** The budget row this file measures. */
const FRAME_TIME_BUDGET_ID = "frame-time-p95-four-lanes";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(FRAME_TIME_BUDGET_ID);

/**
 * How many fresh launches the reported figure is the median of.
 *
 * Each is its own launch because the frozen clock does not rewind: repeat passes in one window
 * would measure an app whose script was already delivered.
 */
const MEASURED_RUN_COUNT = 3;

/** The shortest task the browser reports as a long task, in milliseconds. */
const LONG_TASK_THRESHOLD_MS = 50;

/**
 * The per-frame stall the negative control plants, in milliseconds: synchronous inside the frame's
 * callback, so the verdict does not depend on the display's cadence, and past both twice the row's
 * ceiling and the long-task threshold by a fifth, so each stalled frame is also a long task.
 */
const PLANTED_FRAME_STALL_MS: number = Math.ceil(
  Math.max(budget.limit.canonicalValue * 2, LONG_TASK_THRESHOLD_MS * 1.2),
);

/** One sampled launch, and the overlay scrollbars started in its window when sampling ended. */
interface MeasuredRun extends FrameTimingRun {
  readonly startedOverlayScrollbarCount: number;
}

/** One launch, opened on the concurrent-streaming session and sampled. */
async function runOnce(plantedStallMilliseconds: number): Promise<MeasuredRun> {
  return await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
    await openConcurrentStreamingSessionRoute(appUnderTest);
    const run = await sampleFrameTimings(appUnderTest, plantedStallMilliseconds);
    const census = await readOverlayScrollbars(appUnderTest);
    return { ...run, startedOverlayScrollbarCount: census.startedHosts.length };
  });
}

/** Sums a run's long tasks, in milliseconds. */
function totalMilliseconds(durationsMs: readonly number[]): number {
  return durationsMs.reduce((total, duration) => total + duration, 0);
}

describe.skipIf(!bundleIsBuilt)(
  "endurance — frame time with the concurrent-streaming session open",
  () => {
    it("holds the 95th-percentile frame duration under the budget's ceiling", async () => {
      const perRunPercentiles: number[] = [];
      const perRunMedians: number[] = [];
      const perRunLongTasks: string[] = [];
      for (let runIndex = 0; runIndex < MEASURED_RUN_COUNT; runIndex += 1) {
        const run = await runOnce(0);
        expectFourLaneWorkloadInsideWindow(run);
        perRunPercentiles.push(percentileByNearestRank(run.frameDurationsMs, 0.95));
        perRunMedians.push(percentileByNearestRank(run.frameDurationsMs, 0.5));
        perRunLongTasks.push(
          `${String(run.longTaskDurationsMs.length)} long tasks ` +
            `(${totalMilliseconds(run.longTaskDurationsMs).toFixed(0)} ms), ` +
            `${String(run.startedOverlayScrollbarCount)} overlay scrollbars started`,
        );
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
          `(${perRunMedians.map((value) => value.toFixed(2)).join(", ")}); ` +
          `${perRunLongTasks.join("; ")} — ${RUNNER_CLASS_DESCRIPTION}\n`,
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
          `per-frame stall: ${stalledP95.toFixed(2)} ms; ` +
          `${String(run.longTaskDurationsMs.length)} long tasks\n`,
      );

      expect(stalledP95).toBeGreaterThan(PLANTED_FRAME_STALL_MS);
      // The long tasks printed beside the healthy figure are read by the same observers, so a
      // stall they miss would make that zero meaningless.
      expect(run.longTaskDurationsMs.length).toBeGreaterThan(0);
      expect(
        evaluateBudget(budget, stalledP95).withinBudget,
        "a renderer holding its main thread for twice the frame budget every frame passed this " +
          "budget, so the gate would report green over the one failure it exists to catch",
      ).toBe(false);
    });
  },
);
