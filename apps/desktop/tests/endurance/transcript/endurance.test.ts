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
// Three claims:
//   - It folds the whole log. This is the control for the other two: a fold that dropped nine
//     thousand rows would be fast, retain nothing, and pass everything else.
//   - Its cost is about linear in the log. A quadratic fold is invisible at the two hundred rows
//     other tiers use and fatal at ten thousand. Measured as a ratio between two sizes rather
//     than a wall-clock ceiling, so a slower machine does not break it.
//   - Repeating it retains nothing. A fold that held its own output (a cache keyed by a value
//     never equal twice, a listener, a closure over the previous window) grows without bound in
//     an app left open for a day.
//
// The collection is forced through `heap/sampling.ts`, the tier's one sampler. A runtime that
// gives no collector fails the case instead of falling back to a softer reading: a heap claim
// without a collection is about what V8 had not got round to yet.

import process from "node:process";

import { describe, expect, it } from "vitest";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { HeapSampler, retainedGrowthBytes } from "../heap/sampling.js";
import { createTranscriptEnduranceFixture } from "./endurance.test-support.js";
import { deriveTranscriptWindow } from "@renderer/features/transcript/window/transcript-window.js";

/**
 * The length of log this tier measures the transcript at.
 *
 * Passed to the generator explicitly on every call, since a default deciding it would report one
 * number while measuring whatever the fixture held.
 */
const ENDURANCE_ROW_COUNT = 10_000;

/** A quarter of it, so the cost ratio below is read across a 4× step. */
const LINEARITY_PROBE_ROW_COUNT = 2_500;

/**
 * How much larger the long fold may be than the short one.
 *
 * The step is 4x, so a linear fold lands near 4 and a quadratic one near 16. The measured ratio
 * is about 4.4 (2,500 rows fold in ~2.5 ms, 10,000 in ~11 ms, best of five on an eight-core
 * laptop), and 8 leaves room over noise while sitting half way to the quadratic figure. Fixed
 * per-call overhead can only push the ratio down, so it cannot manufacture a failure.
 */
const SUPERLINEAR_COST_RATIO_CEILING = 8;

/** How many times the fold is repeated when looking for what it keeps. */
const REPEATED_FOLD_COUNT = 20;

/**
 * What twenty folds of a ten-thousand-row log may add to the heap and still pass.
 *
 * Not zero, because V8 keeps code objects, inline caches and deoptimization data alive across a
 * run. Not a fraction of the baseline, since a leak's size does not depend on how large the
 * process was. It is bounded from both sides: one held window over this log measures ~3.9 MB,
 * so a ceiling above that could not catch a fold keeping a single
 * one of its twenty outputs. Two megabytes sits under one window and two orders of magnitude
 * above the ~21 kB twenty clean folds retain.
 */
const REPEATED_FOLD_RETENTION_CEILING_BYTES = 2 * 1024 * 1024;

/** Timing passes per measurement. The fastest is taken; more only sharpens it. */
const MEASUREMENT_SAMPLE_COUNT = 5;

/** One generated session's log, as the events a store would have admitted. */
function enduranceTranscript(rowCount: number): readonly ProjectedSessionEvent[] {
  return createTranscriptEnduranceFixture({ rowCount });
}

/**
 * How long the transcript's fold takes over one log, best of several passes.
 *
 * The best rather than the mean, because the distribution is one-sided: a collection or the
 * scheduler can slow a sample and nothing can make one faster than the work takes. The result is
 * read so the compiler cannot eliminate the fold as dead code.
 */
function fastestFoldMilliseconds(transcript: readonly ProjectedSessionEvent[]): number {
  let fastestPass = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < MEASUREMENT_SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = performance.now();
    const transcriptWindow = deriveTranscriptWindow(transcript);
    const elapsedMilliseconds = performance.now() - startedAt;
    if (transcriptWindow.rows.length === 0) {
      throw new Error("the fold produced no rows, so its timing describes nothing");
    }
    fastestPass = Math.min(fastestPass, elapsedMilliseconds);
  }
  return fastestPass;
}

describe("endurance — the transcript's fold over a long session", () => {
  it("folds every row of a ten-thousand-row session into one complete window", () => {
    // The control for everything else here: a fold that silently dropped most of the log would
    // be fast, retain almost nothing, and satisfy both claims below.
    const transcript = enduranceTranscript(ENDURANCE_ROW_COUNT);
    expect(transcript).toHaveLength(ENDURANCE_ROW_COUNT);

    const transcriptWindow = deriveTranscriptWindow(transcript);

    // Every event the generator scripts is a registered kind the projection places, so every one
    // becomes a row; a window that dropped an event category would otherwise still read complete.
    expect(transcriptWindow.rows).toHaveLength(ENDURANCE_ROW_COUNT);
    // The virtualizer's identity list and the body lookup are two views of one set: a viewport
    // row with no body renders the not-loaded absence, and a body with no viewport row is never
    // drawn.
    expect(transcriptWindow.viewportRows).toHaveLength(transcriptWindow.rows.length);
    expect(transcriptWindow.rowsByKey.size).toBe(transcriptWindow.rows.length);
    // Every generated run group closes, so the window holds no live turn and every row hanging
    // from a run group is collapsed under the terminal run group fold. The rows not collapsed
    // are exactly those belonging to no run group: the session's opening beats. Stated that way
    // rather than as a count, so it does not encode how many beats the generator spends opening
    // a session, and it still fails the day the run group index stops recognizing a run's
    // terminal at scale.
    expect(transcriptWindow.hasActiveTurn).toBe(false);
    const uncollapsedRowKinds = new Set(
      transcriptWindow.rows
        .filter((row) => !transcriptWindow.collapsedRowIds.has(row.id))
        .map((row) => row.kind),
    );
    expect([...uncollapsedRowKinds]).toStrictEqual(["general"]);
    expect(transcriptWindow.collapsedRowIds.size).toBeGreaterThan(0);
  });

  it("does not fold superlinearly as the log grows", () => {
    const shortFoldMilliseconds = fastestFoldMilliseconds(
      enduranceTranscript(LINEARITY_PROBE_ROW_COUNT),
    );
    const longFoldMilliseconds = fastestFoldMilliseconds(enduranceTranscript(ENDURANCE_ROW_COUNT));
    const costRatio = longFoldMilliseconds / shortFoldMilliseconds;

    // Reported before the assertion so a shrinking margin is visible.
    process.stdout.write(
      `[endurance] transcript fold ${shortFoldMilliseconds.toFixed(2)} ms at ` +
        `${String(LINEARITY_PROBE_ROW_COUNT)} rows, ${longFoldMilliseconds.toFixed(2)} ms at ` +
        `${String(ENDURANCE_ROW_COUNT)} rows — ${costRatio.toFixed(2)}× over a 4× log ` +
        `(ceiling ${String(SUPERLINEAR_COST_RATIO_CEILING)}×)\n`,
    );

    expect(costRatio).toBeLessThanOrEqual(SUPERLINEAR_COST_RATIO_CEILING);
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
        `(ceiling ${String(Math.round(REPEATED_FOLD_RETENTION_CEILING_BYTES / 1024))} kB)\n`,
    );

    expect(retainedBytes).toBeLessThanOrEqual(REPEATED_FOLD_RETENTION_CEILING_BYTES);
  });
});

/**
 * Folds once and keeps nothing.
 *
 * A named function because no binding may outlive the call: a loop assigning each window to an
 * outer variable would hold the last one alive and measure the test, not the transcript. The
 * length is read so the fold cannot be eliminated as dead.
 */
function dropFoldOf(transcript: readonly ProjectedSessionEvent[]): void {
  const rowCount = deriveTranscriptWindow(transcript).rows.length;
  if (rowCount === 0) {
    throw new Error("the fold produced no rows, so nothing was measured");
  }
}
