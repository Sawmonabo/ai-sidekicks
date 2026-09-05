// The four-lane frame-time budget, measured — Plan-023 Phase 1C.
//
// `Spec-023 §Console Design (Meridian)` §Budgets bounds the renderer's 95th-
// percentile frame duration at 16.7 ms while four agent lanes stream into the
// ledger. This file is the row's `measuredBy`, and it compares through the
// registry's own `evaluateBudget`, so the number this gate uses and the number the
// spec wrote are one number read from one file.
//
// WHAT THE INSTRUMENT MEASURES, AND WHY IT IS NOT THE INTERVAL BETWEEN FRAMES
//
// The row bounds frame DURATION — `budgets.json`'s own subject line says so, "the
// 95th-percentile frame duration of the renderer" — which is the main-thread work
// one frame costs. Until 2026-09-02 this file sampled the INTERVAL between
// consecutive `requestAnimationFrame` callbacks instead, and that is a different
// quantity: on a surface that presents at 60 Hz a healthy renderer is called back
// every ~16.67 ms whatever it does, so its p95 interval is ~16.7 ms by construction
// and cannot be under a 16.7 ms ceiling. The spec's own reference profile is "one
// 60 Hz display", so the interval reading made the row unpassable on the very
// machine its figure is written for — and on the Xvfb software begin-frame source
// the pinned runner presents through, which is also 60 Hz. The p50 is printed
// beside the p95 for exactly that reason: a p50 pinned at ~16.67 ms is the surface's
// cadence being reported, not the console's work.
//
// So the sample is taken from the START of the frame's animation-frame callback to
// the first task that runs after that frame's rendering has been committed. The
// ordering is the HTML event loop's own: the callback runs inside "update the
// rendering" (whose steps run the animation frame callbacks and then update the
// rendering of the document), while a `MessageChannel` message posted from inside
// that callback is queued on a TASK queue, and the event loop cannot select a task
// until it has finished the rendering update it is in. The first such task
// therefore observes style, layout, and paint for that frame as already done.
// `setTimeout(0)` is not used for this: its timeout is clamped — and clamped harder
// once nested — so it would add the clamp to every reading.
//
// WHY THIS ROW STILL GATES ON ONE MACHINE AND REPORTS ON EVERY OTHER
//
// It is the first hardware-dependent row in the registry to be measured at all.
// `budgets.json`'s `measurementProtocol.hardwareDependent` has always said such a
// reading gates "on the pinned CI runner class the desktop workflow names by
// label", and `pinned-runner-class.ts` is that sentence given a mechanism. A
// duration is not a property of the display, but it is squarely a property of the
// machine: the main-thread work in a frame is what this CPU does in that frame, and
// a runner rasterizing in software is not the reference profile's integrated GPU.
// The figure is therefore printed everywhere — the tier still exercises the
// instrument on every runner — and asserted on one.
//
// The negative control is NOT pinned, on the screenshot tier's reasoning for its
// own fail-closed guard: whether the instrument can tell a stalled frame from a
// healthy one is a claim about the measurement, it holds on every machine, and a
// tier that could not check it anywhere except one runner would be a tier nobody
// finds out has stopped working.
//
// WHAT THE SAMPLED WINDOW ACTUALLY CONTAINS
//
// Four agent lanes streaming into the ledger, which is the row's own subject.
// `bridge/scenarios/flagship.ts` scripts four runs mid-turn at the same tick —
// interleaved thinking, messages, and tool calls across four run chapters, with an
// approval blocking one of them while the other three carry on — and the sampled
// window covers that stretch of it. The run asserts both halves rather than
// describing them: that the script delivered INSIDE the window rather than before
// it, and that four lanes were streaming inside the window, read off the scenario's
// own beats by `scenarios/streaming-lanes.ts`. A scenario that stopped streaming
// would fail the second assertion, which is what the first enforced revision of this
// row could not say — its script carried no assistant beat at all.
//
// What is still not claimed is REVEALED text. The scripted beats carry each body's
// description and never the body, so what the frame renders is a card and its named
// absence; the reveal engine's own budget row is `streaming-cpu-one-lane`, and it
// stays `n/a`.
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

import { withLaunchedConsole, type ConsoleApplication } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { SCENARIO_FIXTURE_GLOBAL } from "../fixture-handles.js";
import { ENDURANCE_LAUNCH_OPTIONS, openFlagshipSessionRoute } from "./console-workload.js";
import { RUNNER_CLASS_DESCRIPTION, isPinnedRunnerClass } from "./pinned-runner-class.js";
import {
  FLAGSHIP_LANE_COUNT,
  FLAGSHIP_SCENARIO,
} from "../../../src/renderer/src/console/bridge/scenarios/flagship.js";
import { peakConcurrentStreamingRuns } from "../../../src/renderer/src/console/bridge/scenarios/streaming-lanes.js";
import { ConsoleBudgetRegistry, evaluateBudget } from "../../../scripts/budget/budget-registry.mjs";

const bundleIsBuilt = fixtureBundleExists();

/** The row this file measures. Named once; every figure below comes off it. */
const FRAME_TIME_BUDGET_ID = "frame-time-p95-four-lanes";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(FRAME_TIME_BUDGET_ID);

/**
 * How many frame durations one run samples.
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
 * on the machine: the stall is synchronous work inside the frame's own callback, so
 * it lands in the measured duration whatever the surface's cadence is. Measured p95
 * 37.40–38.30 ms against a 6.80–9.20 ms clean reading, each pair taken in the same
 * pass of this file on the same machine.
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
 * Sample frame durations while the flagship script delivers into the open session.
 *
 * The whole loop runs inside the renderer. A driver round trip per frame would be
 * the largest thing in every duration it measured, which is the harness timing
 * itself; and the scenario handle is on the page, so the frozen clock can be walked
 * from the same callback the frame's work is timed from.
 *
 * One frame is opened by `requestAnimationFrame` and closed by the message the
 * callback posts to itself — see this file's header for why that message is the
 * first thing to run after the frame's rendering has been committed, and why a
 * timer is not used in its place. The next frame is requested from the CLOSING
 * side, so exactly one measurement is ever open and a frame can never be paired
 * with the wrong one's start.
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

/** One launch, opened on the flagship session and sampled. */
async function runOnce(plantedStallMilliseconds: number): Promise<FrameTimingRun> {
  return await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
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
  });
}

/**
 * The workload was the workload the row names.
 *
 * Three claims, and the third is the one that makes this row's subject true rather
 * than merely asserted: the script finished inside the window, it was still
 * arriving during it, and four lanes were streaming while it did. The lane count
 * comes off the scenario's own cast, so a script that grew a fifth agent and kept
 * four lanes streaming would fail here rather than pass on a stale literal.
 */
function expectFourLaneWorkloadInsideWindow(run: FrameTimingRun): void {
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
  expect(
    peakConcurrentStreamingRuns(
      FLAGSHIP_SCENARIO.beats,
      run.beatsAtWindowStart,
      run.beatsAtWindowEnd,
    ),
    "fewer than four agent lanes were mid-turn at any point inside the sampled window, so this " +
      "figure bounds a console that was not doing the work the budget row names",
  ).toBe(FLAGSHIP_LANE_COUNT);
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
  it("holds the 95th-percentile frame duration under the budget's ceiling", async () => {
    const perRunPercentiles: number[] = [];
    const perRunMedians: number[] = [];
    for (let runIndex = 0; runIndex < MEASURED_RUN_COUNT; runIndex += 1) {
      const run = await runOnce(0);
      expectFourLaneWorkloadInsideWindow(run);
      perRunPercentiles.push(percentileByNearestRank(run.frameDurationsMs, 0.95));
      perRunMedians.push(medianOf(run.frameDurationsMs));
    }
    const measuredP95 = medianOf(perRunPercentiles);
    const verdict = evaluateBudget(budget, measuredP95);

    // Reported before the assertion, and reported on every machine: the figure is
    // the whole value of this run off the pinned class, and on it a reviewer still
    // needs to see a margin shrink before the run that crosses.
    //
    // The p50 is beside the p95 because it is what tells the two possible readings
    // apart. A typical frame's WORK is a small fraction of the frame; a p50 sitting
    // at the surface's own cadence — ~16.67 ms on a 60 Hz presenter — would mean the
    // instrument had gone back to reporting how often frames arrive.
    process.stdout.write(
      `[console-endurance] frame time p95 ${measuredP95.toFixed(2)} ms ` +
        `(median of ${String(MEASURED_RUN_COUNT)} runs: ` +
        `${perRunPercentiles.map((value) => value.toFixed(2)).join(", ")}) ` +
        `of a ${String(budget.limit.canonicalValue)} ms ceiling ` +
        `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
        `p50 ${medianOf(perRunMedians).toFixed(2)} ms ` +
        `(${perRunMedians.map((value) => value.toFixed(2)).join(", ")}) — ` +
        `${RUNNER_CLASS_DESCRIPTION}\n`,
    );

    if (!isPinnedRunnerClass) {
      // Not a skip: the run happened, the instrument was exercised, and the figure
      // is on the record. What is withheld is the COMPARISON, because the work a
      // frame costs on an unpinned machine is a reading about that machine.
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
