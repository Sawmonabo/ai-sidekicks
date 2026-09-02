// The four-lane frame-time budget, measured — Plan-023 Phase 1C.
//
// `Spec-023 §Console Design (Meridian)` §Budgets bounds the renderer's 95th-
// percentile frame duration at 16.7 ms while four agent lanes stream into the
// ledger. This file is the row's `measuredBy`, and it compares through the
// registry's own `evaluateBudget`, so the number this gate uses and the number the
// spec wrote are one number read from one file.
//
// WHY THIS ROW GATES ON ONE MACHINE AND REPORTS ON EVERY OTHER
//
// It is the first hardware-dependent row in the registry to be measured at all.
// `budgets.json`'s `measurementProtocol.hardwareDependent` has always said such a
// reading gates "on the pinned CI runner class the desktop workflow names by
// label", and `pinned-runner-class.ts` is that sentence given a mechanism. A frame
// interval is a property of the display's refresh rate as much as of the console:
// this laptop's compositor delivers frames every ~8 ms and a 60 Hz surface delivers
// them every ~16.7 ms, so the same healthy renderer produces two readings that sit
// on opposite sides of the ceiling. The figure is therefore printed everywhere —
// the tier still exercises the instrument on every runner — and asserted on one.
//
// The negative control is NOT pinned, on the screenshot tier's reasoning for its
// own fail-closed guard: whether the instrument can tell a stalled frame from a
// healthy one is a claim about the measurement, it holds on every machine, and a
// tier that could not check it anywhere except one runner would be a tier nobody
// finds out has stopped working.
//
// WHAT THE SAMPLED WINDOW ACTUALLY CONTAINS
//
// Four agent lanes, and the flagship script delivering into the ledger underneath
// them. `bridge/scenarios/flagship.ts` is the four-lane session — its own header
// says so — and at this revision its script is the SKELETON: eight beats over
// 400 ms, attaching four agents and opening a run. So the sampled window covers the
// whole of that delivery and the settled console after it, and the run asserts the
// delivery happened inside the window rather than before it. It does not claim to
// have sampled four lanes revealing text, because no scripted beat reveals any: the
// reveal engine's own budget row is `streaming-cpu-one-lane`, and it stays `n/a`.
//
// WHY THE WARM-UP IS COUNTED IN FRAMES AND NOT IN SECONDS
//
// The protocol says ten warm-up seconds discarded, which is written for the CPU
// rows' sixty-second average. Applied here it would discard the entire workload:
// the frozen clock only moves when this file moves it, and ten seconds of frames at
// two milliseconds each would walk the script to its end before the first sample
// was taken, leaving three runs that measured an idle console and a p95 no
// regression in the streaming path could ever move. The warm-up is therefore a
// frame count, sized to let the first-frame allocations settle, and the advance per
// frame is derived from the script's own span — the derivation
// `steady-state.test.ts` uses, for the same reason.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  SCENARIO_FIXTURE_GLOBAL,
  fixtureBundleExists,
  launchConsole,
  type ConsoleApplication,
} from "../electron-harness.js";
import { openFlagshipSessionRoute } from "./console-workload.js";
import { RUNNER_CLASS_DESCRIPTION, isPinnedRunnerClass } from "./pinned-runner-class.js";
import { FLAGSHIP_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/flagship.js";
import { ConsoleBudgetRegistry, evaluateBudget } from "../../../scripts/budget/budget-registry.mjs";

const bundleIsBuilt = fixtureBundleExists();

/** The row this file measures. Named once; every figure below comes off it. */
const FRAME_TIME_BUDGET_ID = "frame-time-p95-four-lanes";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(FRAME_TIME_BUDGET_ID);

/**
 * How many frame intervals one run samples.
 *
 * Three hundred is the floor a 95th percentile is worth taking at: the statistic is
 * the fifteenth-slowest of them, so a single hiccup moves it by one rank rather
 * than deciding it, and one rank is the granularity this gate can actually resolve.
 */
const SAMPLED_FRAME_COUNT = 300;

/**
 * Frames discarded before sampling starts.
 *
 * The first frames after a mount carry the virtualizer's initial measurement pass
 * and V8's compilation of paths nothing had run, neither of which is what this
 * budget bounds. Small on purpose — see the header on why this is a frame count.
 */
const WARM_UP_FRAME_COUNT = 30;

/**
 * How many runs the reported figure is the median of.
 *
 * The protocol's "median of three runs", and each is a fresh LAUNCH rather than a
 * third of one: the frozen clock does not rewind, so three passes inside one window
 * would be one run that streamed and two that measured a console with its whole
 * script already delivered — and the median of those is the idle figure, which is
 * the reading a streaming regression hides in.
 */
const MEASURED_RUN_COUNT = 3;

/**
 * The per-frame stall the negative control plants, in milliseconds.
 *
 * Comfortably over the ceiling on its own, so the control's verdict does not depend
 * on the machine's own frame cadence: a display delivering frames every 8 ms and one
 * delivering them every 16.7 ms both cross once every frame carries this much
 * synchronous work. Measured p95 34.3 ms against a 9.1–10.6 ms clean reading.
 */
const PLANTED_FRAME_STALL_MS = 30;

/**
 * The percentile a sorted sample answers at, by nearest rank.
 *
 * Nearest rank rather than an interpolating estimator: the claim is "at most one
 * frame in twenty was slower than this", which is a statement about an observed
 * frame, and an interpolated value is a number no frame took.
 */
function percentileByNearestRank(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

/** The median of a small set of readings, by the same nearest-rank rule. */
function medianOf(readings: readonly number[]): number {
  return percentileByNearestRank(readings, 0.5);
}

/** What one sampled run measured. */
interface FrameTimingRun {
  readonly frameDurationsMs: readonly number[];
  readonly beatsAtWindowStart: number;
  readonly beatsAtWindowEnd: number;
}

/**
 * Sample frame intervals while the flagship script delivers into the open session.
 *
 * The whole loop runs inside the renderer. A driver round trip per frame would be
 * the largest thing in every interval it measured, which is the harness timing
 * itself; and the scenario handle is on the page, so the frozen clock can be walked
 * from the same callback that reads the frame's timestamp.
 */
async function sampleFrameTimings(
  consoleApplication: ConsoleApplication,
  plantedStallMilliseconds: number,
): Promise<FrameTimingRun | null> {
  const scriptSpanMs = FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0;
  const advanceMillisecondsPerFrame = Math.max(1, Math.ceil(scriptSpanMs / SAMPLED_FRAME_COUNT));
  return consoleApplication.window.evaluate(
    async ([
      scenarioGlobalName,
      warmUpFrames,
      sampledFrames,
      advanceMilliseconds,
      stallMilliseconds,
    ]: [string, number, number, number, number]) => {
      const scenarioControl = (
        globalThis as unknown as Record<
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
        let previousFrameAtMs: number | undefined;
        let frameIndex = 0;
        const onFrame = (frameAtMs: number): void => {
          if (frameIndex === warmUpFrames) {
            beatsAtWindowStart = scenarioControl.deliveredBeatCount();
          }
          if (previousFrameAtMs !== undefined && frameIndex > warmUpFrames) {
            frameDurationsMs.push(frameAtMs - previousFrameAtMs);
          }
          previousFrameAtMs = frameAtMs;
          frameIndex += 1;
          scenarioControl.advance(advanceMilliseconds);
          if (stallMilliseconds > 0) {
            const stallUntil = performance.now() + stallMilliseconds;
            while (performance.now() < stallUntil) {
              /* hold the frame, the way a renderer over its budget does */
            }
          }
          if (frameDurationsMs.length >= sampledFrames) {
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

/** One launch, opened on the flagship session and sampled. */
async function runOnce(plantedStallMilliseconds: number): Promise<FrameTimingRun> {
  const consoleApplication = await launchConsole({ scenarioId: FLAGSHIP_SCENARIO.id });
  try {
    await openFlagshipSessionRoute(consoleApplication);
    const run = await sampleFrameTimings(consoleApplication, plantedStallMilliseconds);
    expect(
      run,
      `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build, so no frame in it was driven by a ` +
        "scenario and every interval sampled would describe an idle window",
    ).not.toBeNull();
    if (run === null) {
      throw new Error("unreachable: the assertion above fails first");
    }
    expect(run.frameDurationsMs).toHaveLength(SAMPLED_FRAME_COUNT);
    return run;
  } finally {
    await consoleApplication.close();
  }
}

/** The workload was a workload: the script delivered inside the sampled window. */
function expectDeliveryInsideWindow(run: FrameTimingRun): void {
  expect(
    run.beatsAtWindowEnd,
    "the flagship script had not finished delivering by the end of the sampled window, so the " +
      "reading describes a console the session never fully reached",
  ).toBe(FLAGSHIP_SCENARIO.beats.length);
  expect(
    run.beatsAtWindowEnd,
    "every beat had already been delivered before sampling started, so these frames measured a " +
      "settled console rather than one with a session arriving in it",
  ).toBeGreaterThan(run.beatsAtWindowStart);
}

describe("the four-lane frame-time budget row", () => {
  // The ceiling and the unit are the budget tier's to hold. What only THIS file can
  // say is that it is the harness the row names — so a reading that moves away, or a
  // row flipped back to ungated while this gate keeps running, fails here.
  it("is the harness the row names as its measurer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe("apps/desktop/test/console/endurance/frame-time.test.ts");
    expect(budget.notMeasurableReason).toBeNull();
  });
});

describe.skipIf(!bundleIsBuilt)("endurance — frame time with the flagship session open", () => {
  it("holds the 95th-percentile frame interval under the budget's ceiling", async () => {
    const perRunPercentiles: number[] = [];
    for (let runIndex = 0; runIndex < MEASURED_RUN_COUNT; runIndex += 1) {
      const run = await runOnce(0);
      expectDeliveryInsideWindow(run);
      perRunPercentiles.push(percentileByNearestRank(run.frameDurationsMs, 0.95));
    }
    const measuredP95 = medianOf(perRunPercentiles);
    const verdict = evaluateBudget(budget, measuredP95);

    // Reported before the assertion, and reported on every machine: the figure is
    // the whole value of this run off the pinned class, and on it a reviewer still
    // needs to see a margin shrink before the run that crosses.
    process.stdout.write(
      `[console-endurance] frame time p95 ${measuredP95.toFixed(2)} ms ` +
        `(median of ${String(MEASURED_RUN_COUNT)} runs: ` +
        `${perRunPercentiles.map((value) => value.toFixed(2)).join(", ")}) ` +
        `of a ${String(budget.limit.canonicalValue)} ms ceiling ` +
        `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) — ` +
        `${RUNNER_CLASS_DESCRIPTION}\n`,
    );

    if (!isPinnedRunnerClass) {
      // Not a skip: the run happened, the instrument was exercised, and the figure
      // is on the record. What is withheld is the COMPARISON, because a frame
      // interval on an unpinned machine is a reading about that machine's display.
      return;
    }
    expect(
      verdict.withinBudget,
      `${budget.label}: ${measuredP95.toFixed(2)} ms against a ` +
        `${String(budget.limit.canonicalValue)} ms ceiling`,
    ).toBe(true);
  });

  it("negative control: a planted frame stall crosses the same ceiling", async () => {
    // Without this the case above would pass over an instrument that reported a
    // constant, sampled nothing, or divided by the wrong number — and off the pinned
    // runner class it would pass over an instrument that had stopped measuring
    // entirely, since nothing there asserts on the figure. The stall is real
    // synchronous work inside each frame's own callback, driven through the SAME
    // sampler, so what is shown is that this gate's own comparison fails on a
    // renderer that misses its budget.
    const run = await runOnce(PLANTED_FRAME_STALL_MS);
    const stalledP95 = percentileByNearestRank(run.frameDurationsMs, 0.95);
    process.stdout.write(
      `[console-endurance] frame time p95 under a planted ${String(PLANTED_FRAME_STALL_MS)} ms ` +
        `per-frame stall: ${stalledP95.toFixed(2)} ms\n`,
    );

    expect(stalledP95).toBeGreaterThan(PLANTED_FRAME_STALL_MS);
    expect(
      evaluateBudget(budget, stalledP95).withinBudget,
      "a renderer holding its main thread for twice the frame budget every frame passed this " +
        "budget, so the gate would report green over the one failure it exists to catch",
    ).toBe(false);
  });
});
