// The transcript under a log as long as it claims to survive. This file measures the
// transcript's own fold, `deriveTranscriptWindow` (a session's event log into rows, run groups,
// seams and a superseded index), over a generated session of ten thousand rows, without launching
// Electron.
//
// It cannot launch one: the endurance log is not a scenario in `fixtures/index.ts`, so no
// launched app can be asked to play it. The generator is called directly with the row count.
//
// A Node heap reading is honest here though not in `heap/at-rest.test.ts`. That file's subject
// is the renderer heap, which a Node process cannot reach. This file's subject is the fold's own
// retained structures, which live in whatever process runs the fold. It states no renderer
// ceiling.
//
// Four claims:
//   - It folds the whole log. This is the control for the other two: a fold that dropped nine
//     thousand rows would be fast, retain nothing, and pass everything else.
//   - Its cost is about linear in the log. A quadratic fold is invisible at the two hundred rows
//     other tiers use and fatal at ten thousand. Measured as a ratio between two sizes, in
//     processor time rather than wall time, so neither a slower machine nor a busy one breaks it.
//   - Repeating it retains nothing. A fold that held its own output (a cache keyed by a value
//     never equal twice, a listener, a closure over the previous window) grows without bound in
//     an app left open for a day.
//   - A ten-thousand-call run's window walks from the newest calls to the first and back, a press
//     at a time, at a bounded cost per press, holding no more than its let-go distance in the
//     list and retaining nothing of the stretches it let go.
//
// The collection is forced through `heap/sampling.ts`, the tier's one sampler. A runtime that
// gives no collector fails the case instead of falling back to a softer reading: a heap claim
// without a collection is about what V8 had not got round to yet.

import process from "node:process";

import { describe, expect, it } from "vitest";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { HeapSampler, retainedGrowthBytes, type HeapSample } from "../heap/sampling.js";
import { createTranscriptEnduranceFixture } from "./long-log.test-support.js";
import { RunGroupFold } from "#renderer/features/transcript/feed/run-group-fold.js";
import { measuredRunWindowInputs } from "#renderer/features/transcript/feed/run-group-fold.test-support.js";
import { type RunWindowEdge } from "#renderer/features/transcript/runs/call-window.js";
import {
  longRunEvents,
  onlyRunGroupOf,
} from "#renderer/features/transcript/runs/call-window.test-support.js";
import { type RunGroup } from "#renderer/features/transcript/runs/groups.js";
import {
  TRANSCRIPT_LET_GO_SCREEN_HEIGHTS,
  TRANSCRIPT_STRETCH_SCREEN_HEIGHTS,
} from "#renderer/features/transcript/viewport/caps.js";
import { deriveTranscriptWindow } from "#renderer/features/transcript/window/transcript-window.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";
import { runEntitiesOf } from "#test/helpers/transcript/run-facts.js";

/**
 * The length of log this tier measures the transcript at.
 *
 * Passed to the generator explicitly on every call, since a default deciding it would report one
 * number while measuring whatever the fixture held.
 */
const ENDURANCE_ROW_COUNT = 10_000;

/** A quarter of it, so the cost ratio below is read across a 4× step. */
const LINEARITY_PROBE_ROW_COUNT = 2_500;

const registry = BudgetRegistry.load();

/** How much costlier the long fold may be than the short one; its row says why that figure. */
const foldCostRatioBudget = registry.requireBudget("transcript-fold-cost-ratio");

/** How many times the fold is repeated when looking for what it keeps. */
const REPEATED_FOLD_COUNT = 20;

/** What the repeated folds may add to the heap and still pass; its row says why that figure. */
const foldRetentionBudget = registry.requireBudget("transcript-fold-retention");

/** Rounds that each fold the short log and then the long one; the median round's ratio is read. */
const RATIO_ROUND_COUNT = 15;

/** Rounds folded first and not read, so the fold's code is compiled before any is timed. */
const RATIO_WARM_UP_ROUND_COUNT = 3;

/** Events in the long run: ten thousand and one calls, with a running row after every nine. */
const LONG_RUN_EVENT_COUNT = 11_112;

/** The screen the run's window is cut in: fifty calls high. */
const RUN_WINDOW_MEASURE = { screenHeightPx: () => 1_000, rowHeightPx: () => 20 };

/** Sweeps from the newest calls to the first and back, the first a warm-up nothing is read from. */
const RUN_WINDOW_SWEEP_COUNT = 9;

/** How long the fold takes after one press, in processor time; its row says why that figure. */
const pressMedianBudget = registry.requireBudget("run-window-press-cpu-median");

/** The slowest press's fold, in processor time; its row says why that figure. */
const pressWorstBudget = registry.requireBudget("run-window-press-cpu-worst");

/** What the sweeps after the warm-up may add to the heap; its row says why that figure. */
const runWindowRetentionBudget = registry.requireBudget("run-window-sweep-retention");

/** One generated session's log, as the events a store would have admitted. */
function enduranceTranscript(rowCount: number): readonly ProjectedSessionEvent[] {
  return createTranscriptEnduranceFixture({ rowCount });
}

/**
 * The processor time of one fold over `transcript`. Processor time rather than wall time, so a
 * busy machine taking the thread away mid-fold does not count. The result is read so the compiler
 * cannot eliminate the fold as dead code.
 */
function foldCpuMilliseconds(transcript: readonly ProjectedSessionEvent[]): number {
  const before = process.threadCpuUsage();
  const transcriptWindow = deriveTranscriptWindow(transcript, runEntitiesOf(transcript));
  const spent = process.threadCpuUsage(before);
  if (transcriptWindow.rows.length === 0) {
    throw new Error("the fold produced no rows, so its timing describes nothing");
  }
  return (spent.user + spent.system) / 1000;
}

describe("endurance — the transcript's fold over a long session", () => {
  it("folds every row of a ten-thousand-row session into one complete window", () => {
    // The control for everything else here: a fold that silently dropped most of the log would
    // be fast, retain almost nothing, and satisfy both claims below.
    const transcript = enduranceTranscript(ENDURANCE_ROW_COUNT);
    expect(transcript).toHaveLength(ENDURANCE_ROW_COUNT);

    const transcriptWindow = deriveTranscriptWindow(transcript, runEntitiesOf(transcript));

    // Every event the generator scripts is a registered kind the projection places, so every one
    // becomes a row; a window that dropped an event category would otherwise still read complete.
    expect(transcriptWindow.rows).toHaveLength(ENDURANCE_ROW_COUNT);
    // The virtualizer's identity list and the body lookup are two views of one set: a viewport
    // row with no body renders the not-loaded absence, and a body with no viewport row is never
    // drawn.
    expect(transcriptWindow.viewportRows).toHaveLength(transcriptWindow.rows.length);
    expect(transcriptWindow.rowsByKey.size).toBe(transcriptWindow.rows.length);
    // Every generated run closes, so the window holds no live turn. Stated that way rather than as
    // a count, so it still fails the day the run group index stops recognizing a run's terminal at
    // scale.
    expect(transcriptWindow.liveRunIds.size).toBe(0);
  });

  it("does not fold superlinearly as the log grows", () => {
    const shortTranscript = enduranceTranscript(LINEARITY_PROBE_ROW_COUNT);
    const longTranscript = enduranceTranscript(ENDURANCE_ROW_COUNT);
    // Each round folds both sizes back to back, so a stretch of a busy machine slows both halves
    // of one ratio rather than one size's every sample.
    const shortFoldMs = new Float64Array(RATIO_ROUND_COUNT);
    const longFoldMs = new Float64Array(RATIO_ROUND_COUNT);
    const roundRatios = new Float64Array(RATIO_ROUND_COUNT);
    for (let round = -RATIO_WARM_UP_ROUND_COUNT; round < RATIO_ROUND_COUNT; round += 1) {
      const shortMs = foldCpuMilliseconds(shortTranscript);
      const longMs = foldCpuMilliseconds(longTranscript);
      if (round >= 0) {
        shortFoldMs[round] = shortMs;
        longFoldMs[round] = longMs;
        roundRatios[round] = longMs / shortMs;
      }
    }
    const costRatio = medianOf(roundRatios);

    // Reported before the assertion so a shrinking margin is visible.
    process.stdout.write(
      `[endurance] transcript fold ${medianOf(shortFoldMs).toFixed(2)} ms at ` +
        `${String(LINEARITY_PROBE_ROW_COUNT)} rows, ${medianOf(longFoldMs).toFixed(2)} ms at ` +
        `${String(ENDURANCE_ROW_COUNT)} rows — median round ${costRatio.toFixed(2)}× over a 4× ` +
        `log (ceiling ${String(foldCostRatioBudget.limit.canonicalValue)}×)\n`,
    );

    expect(
      evaluateBudget(foldCostRatioBudget, costRatio).withinBudget,
      `${foldCostRatioBudget.label}: ${costRatio.toFixed(2)}× against a ` +
        `${String(foldCostRatioBudget.limit.canonicalValue)}× ceiling`,
    ).toBe(true);
  });

  it("retains nothing of the folds it has already produced", async () => {
    const heapSampler = new HeapSampler();
    if (!heapSampler.isCollectorAvailable) {
      throw new Error(
        "this runtime gives no collector, so no heap figure " +
          "here would describe what the transcript retains",
      );
    }
    // One fold before the baseline, dropped, so the first fold's one-time costs (the
    // projection's module state, V8's compiled code) are not reported as retention.
    const transcript = enduranceTranscript(ENDURANCE_ROW_COUNT);
    dropFoldOf(transcript);
    const baseline = await heapSampler.sample();

    for (let foldIndex = 0; foldIndex < REPEATED_FOLD_COUNT; foldIndex += 1) {
      dropFoldOf(transcript);
    }
    const retainedBytes = retainedGrowthBytes(baseline, await heapSampler.sample());

    process.stdout.write(
      `[endurance] transcript fold retention ${String(Math.round(retainedBytes / 1024))} kB ` +
        `over ${String(REPEATED_FOLD_COUNT)} folds of ${String(ENDURANCE_ROW_COUNT)} rows ` +
        `(ceiling ${String(Math.round(foldRetentionBudget.limit.canonicalValue / 1024))} kB)\n`,
    );

    expect(
      evaluateBudget(foldRetentionBudget, retainedBytes).withinBudget,
      `${foldRetentionBudget.label}: ${String(retainedBytes)} B against a ` +
        `${String(foldRetentionBudget.limit.canonicalValue)} B ceiling`,
    ).toBe(true);
  });

  it("walks a ten-thousand-call run's window end to end at a bounded cost per press", async () => {
    const heapSampler = new HeapSampler();
    expect(heapSampler.isCollectorAvailable, "this runtime gives no collector").toBe(true);
    const events = longRunEvents(LONG_RUN_EVENT_COUNT);
    const model = deriveTranscriptWindow(events, runEntitiesOf(events));
    const runGroup = onlyRunGroupOf(model);
    const inputs = measuredRunWindowInputs(RUN_WINDOW_MEASURE);
    const fold = new RunGroupFold();
    fold.fold(model, new Set(), inputs);
    const listRowBound = mostListRowsUnderLetGo(model.viewportRows.length, runGroup);

    // Read into arrays sized before the first press, so the readings add nothing to the heap
    // they measure. A press moves the window at least a stretch, which bounds the presses.
    const stretchCalls =
      (TRANSCRIPT_STRETCH_SCREEN_HEIGHTS * RUN_WINDOW_MEASURE.screenHeightPx()) /
      RUN_WINDOW_MEASURE.rowHeightPx();
    const pressCapacity =
      RUN_WINDOW_SWEEP_COUNT *
      2 *
      (Math.ceil(runGroup.drawnRowPositions.length / stretchCalls) + 1);
    const pressCpuMs = new Float64Array(pressCapacity);
    const growthBytes = new Float64Array(RUN_WINDOW_SWEEP_COUNT - 1);
    let pressCount = 0;
    let measuredFrom = 0;
    let mostListRows = 0;
    let baseline: HeapSample | undefined;
    for (let sweep = 0; sweep < RUN_WINDOW_SWEEP_COUNT; sweep += 1) {
      for (const edge of ["earlier", "later"] as const) {
        while (
          callsBeyond(inputs.windows.resolvedWindowOf(runGroup.key), edge) > 0 &&
          pressCount < pressCapacity
        ) {
          const before = process.threadCpuUsage();
          inputs.windows.openStretch(runGroup, edge, RUN_WINDOW_MEASURE);
          const stage = fold.fold(model, new Set(), { ...inputs, moveCount: pressCount + 1 });
          const spent = process.threadCpuUsage(before);
          pressCpuMs[pressCount] = (spent.user + spent.system) / 1000;
          pressCount += 1;
          mostListRows = Math.max(mostListRows, stage.window.viewportRows.length);
        }
      }
      // The warm-up sweep's presses compile the walk; they are timed but not read.
      if (sweep === 0) {
        measuredFrom = pressCount;
        baseline = await heapSampler.sample();
      } else if (baseline !== undefined) {
        growthBytes[sweep - 1] = retainedGrowthBytes(baseline, await heapSampler.sample());
      }
    }

    const measured = pressCpuMs.subarray(measuredFrom, pressCount);
    const medianMs = medianOf(measured);
    const worstMs = Math.max(...measured);
    const peakGrowthBytes = Math.max(...growthBytes);
    process.stdout.write(
      `[endurance] run window over ${String(runGroup.drawnRowPositions.length)} calls: ` +
        `${String(measured.length)} presses, fold cpu median ${medianMs.toFixed(2)} ms, worst ` +
        `${worstMs.toFixed(2)} ms; most list rows ${String(mostListRows)} of ` +
        `${String(listRowBound)}; heap growth by sweep ` +
        `${[...growthBytes].map((bytes) => String(Math.round(bytes / 1024))).join(", ")} kB\n`,
    );

    // Every sweep reached both ends of the run: a window that never reaches one stops the sweep
    // at the presses' bound rather than spinning forever.
    expect(pressCount, "a sweep never reached an end of the run").toBeLessThan(pressCapacity);
    // The sweeps walked the whole run a stretch at a time: a press that skipped ahead would be
    // cheap and pass everything else.
    const callsOutsideWindow =
      runGroup.drawnRowPositions.length -
      (TRANSCRIPT_LET_GO_SCREEN_HEIGHTS * RUN_WINDOW_MEASURE.screenHeightPx()) /
        RUN_WINDOW_MEASURE.rowHeightPx();
    expect(measured.length).toBeGreaterThanOrEqual(
      (RUN_WINDOW_SWEEP_COUNT - 1) * 2 * Math.floor(callsOutsideWindow / stretchCalls),
    );
    expect(mostListRows).toBeLessThanOrEqual(listRowBound);
    expect(
      evaluateBudget(pressMedianBudget, medianMs).withinBudget,
      `${pressMedianBudget.label}: ${medianMs.toFixed(2)} ms against a ` +
        `${String(pressMedianBudget.limit.canonicalValue)} ms ceiling`,
    ).toBe(true);
    expect(
      evaluateBudget(pressWorstBudget, worstMs).withinBudget,
      `${pressWorstBudget.label}: ${worstMs.toFixed(2)} ms against a ` +
        `${String(pressWorstBudget.limit.canonicalValue)} ms ceiling`,
    ).toBe(true);
    expect(
      evaluateBudget(runWindowRetentionBudget, peakGrowthBytes).withinBudget,
      `${runWindowRetentionBudget.label}: ${String(peakGrowthBytes)} B against a ` +
        `${String(runWindowRetentionBudget.limit.canonicalValue)} B ceiling`,
    ).toBe(true);
  });
});

/** The median of `values`, read from a sorted copy. */
function medianOf(values: Float64Array): number {
  return values.slice().sort()[Math.floor(values.length / 2)] ?? Number.NaN;
}

/** The calls a window leaves out beyond `edge`; none before the first fold resolves it. */
function callsBeyond(
  window: { readonly earlierCount: number; readonly laterCount: number } | undefined,
  edge: RunWindowEdge,
): number {
  return (edge === "earlier" ? window?.earlierCount : window?.laterCount) ?? 0;
}

/**
 * The most rows the list may hold while the run's window spans its let-go distance: every row
 * outside the run, the run's header and two edge lines, and the most rows any let-go distance of
 * calls covers, counting the rows before the first call and after the newest at the ends.
 */
function mostListRowsUnderLetGo(unfoldedRowCount: number, runGroup: RunGroup): number {
  const positions = runGroup.drawnRowPositions;
  const lastRowPosition = runGroup.rowIds.length - 1;
  const windowCalls =
    (TRANSCRIPT_LET_GO_SCREEN_HEIGHTS * RUN_WINDOW_MEASURE.screenHeightPx()) /
    RUN_WINDOW_MEASURE.rowHeightPx();
  let mostRunRows = 0;
  for (let first = 0; first < positions.length; first += 1) {
    const end = Math.min(first + windowCalls, positions.length);
    const firstRow = first === 0 ? 0 : (positions[first] ?? 0);
    const lastRow = end === positions.length ? lastRowPosition : (positions[end - 1] ?? 0);
    mostRunRows = Math.max(mostRunRows, lastRow - firstRow + 1);
  }
  return unfoldedRowCount - runGroup.rowIds.length + 1 + 2 + mostRunRows;
}

/**
 * Folds once and keeps nothing.
 *
 * A named function because no binding may outlive the call: a loop assigning each window to an
 * outer variable would hold the last one alive and measure the test, not the transcript. The
 * length is read so the fold cannot be eliminated as dead.
 */
function dropFoldOf(transcript: readonly ProjectedSessionEvent[]): void {
  const rowCount = deriveTranscriptWindow(transcript, runEntitiesOf(transcript)).rows.length;
  if (rowCount === 0) {
    throw new Error("the fold produced no rows, so nothing was measured");
  }
}
