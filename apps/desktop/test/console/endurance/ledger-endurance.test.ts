// The ledger under a log as long as it claims to survive.
//
// WHAT THIS FILE MEASURES, AND WHY IT IS THE ONLY THING IN THIS TIER THAT DOES NOT
// LAUNCH ELECTRON
//
// Its two neighbours hold a real window open and read the renderer's heap. This one
// measures the ledger's own FOLD — `deriveLedgerWindow`, which turns a session's
// event log into rows, chapters, seams, a rail model and a superseded index — over a
// generated session of ten thousand rows.
//
// It cannot be one of those runs, and the reason is structural rather than a
// preference: the endurance scenario is deliberately absent from
// `bridge/scenarios/index.ts`, so no launched console can be asked to play it. The
// scenario module says why — nobody wants a ten-thousand-row session in the fixture
// picker, and every suite that iterates the shipped set would pay for one. A
// launched console therefore reaches this workload through no path at all, and the
// generator is instead what its own header calls it: a generator the endurance and
// bench tiers call with the row count they are measuring.
//
// WHY A NODE HEAP READING IS HONEST HERE AND IS NOT IN `heap-at-rest.test.ts`
//
// That file refuses a Node reading, correctly: its subject is the RENDERER heap, and
// a Node process holds no Chromium, no renderer isolate, no React and no DOM, so
// every figure available there is short of the subject by everything that makes it
// one. The subject HERE is the fold's own retained structures, and those live in
// whatever process runs the fold. So the two readings are not the same reading taken
// in two places; they are two subjects, and each is measured where it lives. This
// file owns no renderer ceiling and states none.
//
// THREE CLAIMS, AND WHY EACH IS WORTH A RUN
//
//   • **It folds the whole log.** The control for the other two: a fold that dropped
//     nine thousand rows would be fast and would retain nothing, and would pass every
//     other assertion in this file.
//   • **Its cost is about linear in the log.** The defect that actually ends a long
//     session is a quadratic fold — invisible at the two hundred rows every other
//     tier exercises, and fatal at ten thousand. Measured as a RATIO between two
//     sizes rather than against a wall-clock ceiling, so the claim survives being run
//     on a slower machine, which a millisecond budget would not.
//   • **Repeating it retains nothing.** A fold that held onto its own output — a
//     cache keyed by a value that is never equal twice, a listener, a closure over
//     the previous window — grows without bound in a console left open for a day,
//     which is the whole reason this tier exists.
//
// The collection below is FORCED rather than waited for. Node exposes no `gc` by
// default and this tier cannot pass a process flag to itself, so the flag is set at
// runtime and the function pulled out of a fresh context — the documented way to get
// one. It is resolved once, at module scope, and a failure to resolve it throws
// rather than falling back to a softer reading: a heap claim taken without a
// collection is a claim about what V8 had not got round to yet.

import { setFlagsFromString } from "node:v8";
import process from "node:process";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { createLedgerEnduranceScenario } from "../../../src/renderer/src/console/bridge/scenarios/ledger-endurance.js";
import { deriveLedgerWindow } from "../../../src/renderer/src/console/ledger/pane/ledger-window.js";
import type { ConsoleSessionEvent } from "../../../src/renderer/src/console/store/index.js";

/**
 * The length of log this tier measures the ledger at.
 *
 * Passed to the generator EXPLICITLY on every call in this file rather than left to
 * its default, on the generator's own reasoning: an endurance reading names the row
 * count it was taken at, and a caller that let a default decide would be reporting
 * one number while measuring whatever the fixture happened to hold that week.
 */
const ENDURANCE_ROW_COUNT = 10_000;

/** A quarter of it, so the cost ratio below is read across a 4× step. */
const LINEARITY_PROBE_ROW_COUNT = 2_500;

/**
 * How much larger the long fold may be than the short one.
 *
 * The step is 4×, so a linear fold lands near 4 and a quadratic one near 16. Set from
 * the measurement rather than from the arithmetic: the measured ratio is about 4.4
 * (2,500 rows fold in ~2.5 ms, 10,000 in ~11 ms, best of five on an eight-core
 * laptop), and this leaves comfortably over the noise while sitting half way to the
 * quadratic figure it exists to catch. Fixed per-call overhead can only push the
 * ratio DOWN — the larger fold amortises it further — so it cannot manufacture a
 * failure here.
 */
const SUPERLINEAR_COST_RATIO_CEILING = 8;

/** How many times the fold is repeated when looking for what it keeps. */
const REPEATED_FOLD_COUNT = 20;

/**
 * What twenty folds of a ten-thousand-row log may add to the heap and still pass.
 *
 * Not zero, because V8 keeps code objects, inline caches and deoptimization data
 * alive across a run and none of that is the ledger's doing. Not a fraction of the
 * baseline either, for `steady-state.test.ts`' reason: what is being bounded is a
 * leak, and a leak's size has nothing to do with how large the process was to begin
 * with.
 *
 * It is bounded from BOTH sides, and the lower bound is the one that makes it a
 * gate. One held window over this log measures ~3.9 MB — measured by the negative
 * control below, not assumed — so a ceiling above that figure could not catch a fold
 * that kept a single one of its twenty outputs, which is the exact defect this case
 * exists for. Two megabytes sits under one window and two orders of magnitude above
 * the ~21 kB twenty clean folds actually retain.
 */
const REPEATED_FOLD_RETENTION_CEILING_BYTES = 2 * 1024 * 1024;

/** Readings per measurement. The best of them is taken; more only sharpens it. */
const MEASUREMENT_SAMPLE_COUNT = 5;

/**
 * A real collection, forced.
 *
 * Resolved once at module scope — the shape `heap-at-rest.test.ts` uses for its own
 * bundle probe. It throws rather than degrading, because every heap figure below is
 * meaningless without it and a run that reported them anyway would be reporting
 * whatever V8 had not yet swept.
 */
const collectGarbage: () => void = resolveForcedCollection();

function resolveForcedCollection(): () => void {
  setFlagsFromString("--expose-gc");
  const exposed: unknown = runInNewContext("gc");
  if (typeof exposed !== "function") {
    throw new Error(
      "this runtime exposed no collector under --expose-gc, so no heap figure in this tier would describe what the ledger retains",
    );
  }
  return exposed as () => void;
}

/** One generated session's log, as the events a store would have admitted. */
function enduranceTimeline(rowCount: number): readonly ConsoleSessionEvent[] {
  return createLedgerEnduranceScenario({ rowCount }).beats.map((beat) => beat.event);
}

/**
 * The heap after collecting, as the smallest of several readings.
 *
 * The minimum rather than the last, because a collection is not a barrier: the
 * smallest figure over several passes is the one closest to what is actually
 * reachable, and it is the same estimator the renderer-side reading uses for the
 * same reason.
 */
function settledHeapBytes(): number {
  let smallestReading = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < MEASUREMENT_SAMPLE_COUNT; sampleIndex += 1) {
    collectGarbage();
    smallestReading = Math.min(smallestReading, process.memoryUsage().heapUsed);
  }
  return smallestReading;
}

/**
 * How long the ledger's fold takes over one log, best of several passes.
 *
 * The best rather than the mean, because the distribution is one-sided: a sample can
 * be slowed by a collection or by the scheduler and nothing can make one faster than
 * the work takes. The result is read before the timer is compared so the fold cannot
 * be eliminated as dead code — and read as a length rather than discarded, because a
 * fold whose output nobody touches is a fold the compiler is free to shorten.
 */
function fastestFoldMilliseconds(timeline: readonly ConsoleSessionEvent[]): number {
  let fastestPass = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < MEASUREMENT_SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = performance.now();
    const ledgerWindow = deriveLedgerWindow(timeline, false);
    const elapsedMilliseconds = performance.now() - startedAt;
    if (ledgerWindow.rows.length === 0) {
      throw new Error("the fold produced no rows, so its timing describes nothing");
    }
    fastestPass = Math.min(fastestPass, elapsedMilliseconds);
  }
  return fastestPass;
}

/**
 * A deliberately quadratic fold over the same shape of input.
 *
 * The negative control's subject. It walks every pair of rows and accumulates, which
 * is the cost shape a real defect would have — an index rebuilt per row, a
 * `find` inside a loop over the same list — rather than a synthetic spin, so the
 * ratio it produces is the ratio the instrument is being asked to catch.
 *
 * Best of several passes, exactly as `fastestFoldMilliseconds` is, and that is not
 * incidental symmetry: a control is only evidence about an instrument if it is read
 * THROUGH that instrument. Timed once, the short pass carries the whole cost of
 * warming a path nothing had run before, which inflates the small reading and
 * divides the ratio down — a genuinely quadratic fold reported 5.95× over a 4× step
 * that way, and the control failed for a reason that had nothing to do with the
 * shape it was planted to prove.
 */
function quadraticFoldMilliseconds(timeline: readonly ConsoleSessionEvent[]): number {
  let fastestPass = Number.POSITIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < MEASUREMENT_SAMPLE_COUNT; sampleIndex += 1) {
    const startedAt = performance.now();
    let matchedPairCount = 0;
    for (const outerEvent of timeline) {
      for (const innerEvent of timeline) {
        if (outerEvent.kind === innerEvent.kind) {
          matchedPairCount += 1;
        }
      }
    }
    const elapsedMilliseconds = performance.now() - startedAt;
    if (matchedPairCount === 0) {
      throw new Error("the planted quadratic matched nothing, so its timing describes nothing");
    }
    fastestPass = Math.min(fastestPass, elapsedMilliseconds);
  }
  return fastestPass;
}

describe("endurance — the ledger's fold over a long session", () => {
  it("folds every row of a ten-thousand-row session into one complete window", () => {
    // The control for everything else here. A fold that silently dropped most of the
    // log would be fast, would retain almost nothing, and would satisfy both of the
    // claims below — so what they mean rests on this one.
    const timeline = enduranceTimeline(ENDURANCE_ROW_COUNT);
    expect(timeline).toHaveLength(ENDURANCE_ROW_COUNT);

    const ledgerWindow = deriveLedgerWindow(timeline, false);

    // Every event the generator scripts is a registered kind the projection places,
    // so nothing in this log may land in the unprojectable count — which is the
    // reading that would otherwise let a window "complete" while dropping a whole
    // event family on the floor.
    expect(ledgerWindow.unprojectableEventCount).toBe(0);
    expect(ledgerWindow.rows.length).toBeGreaterThan(0);
    // The virtualizer's identity list and the body lookup are two views of one set:
    // a viewport row with no body renders the not-loaded absence, and a body with no
    // viewport row is never drawn at all.
    expect(ledgerWindow.viewportRows).toHaveLength(ledgerWindow.rows.length);
    expect(ledgerWindow.rowsByKey.size).toBe(ledgerWindow.rows.length);
    // Every generated chapter closes, so the window holds no live turn — and every
    // row that hangs from a chapter is collapsed under the terminal-chapter fold.
    // The rows that are NOT collapsed are exactly the ones that belong to no chapter:
    // the session's opening beats, whose arm structurally carries no run. Stated that
    // way rather than as a count, so the claim does not encode how many beats the
    // generator happens to spend opening a session — and it still fails the day the
    // chapter index stops recognising a run's terminal at scale, because those rows
    // would join the uncollapsed set carrying a run.
    expect(ledgerWindow.hasActiveTurn).toBe(false);
    const uncollapsedRowKinds = new Set(
      ledgerWindow.rows
        .filter((row) => !ledgerWindow.collapsedRowIds.has(row.id))
        .map((row) => row.kind),
    );
    expect([...uncollapsedRowKinds]).toStrictEqual(["general"]);
    expect(ledgerWindow.collapsedRowIds.size).toBeGreaterThan(0);
  });

  it("does not fold superlinearly as the log grows", () => {
    const shortFoldMilliseconds = fastestFoldMilliseconds(
      enduranceTimeline(LINEARITY_PROBE_ROW_COUNT),
    );
    const longFoldMilliseconds = fastestFoldMilliseconds(enduranceTimeline(ENDURANCE_ROW_COUNT));
    const costRatio = longFoldMilliseconds / shortFoldMilliseconds;

    // Reported before the assertion, on the reasoning both neighbours state: a gate
    // that speaks only when it fails gives a reviewer no way to watch a margin
    // shrink over months until the day it crosses.
    process.stdout.write(
      `[console-endurance] ledger fold ${shortFoldMilliseconds.toFixed(2)} ms at ` +
        `${String(LINEARITY_PROBE_ROW_COUNT)} rows, ${longFoldMilliseconds.toFixed(2)} ms at ` +
        `${String(ENDURANCE_ROW_COUNT)} rows — ${costRatio.toFixed(2)}× over a 4× log ` +
        `(ceiling ${String(SUPERLINEAR_COST_RATIO_CEILING)}×)\n`,
    );

    expect(costRatio).toBeLessThanOrEqual(SUPERLINEAR_COST_RATIO_CEILING);
  });

  it("negative control: the same ratio catches a planted quadratic", () => {
    // Without this the case above would pass over an instrument that could not tell
    // linear from quadratic at all — two timings that were both noise would divide
    // to something small and report clean. The planted fold is measured across the
    // same 4× step, at sizes small enough that a quadratic finishes quickly and
    // large enough that neither reading is dominated by the clock.
    const shortQuadraticMilliseconds = quadraticFoldMilliseconds(enduranceTimeline(1_000));
    const longQuadraticMilliseconds = quadraticFoldMilliseconds(enduranceTimeline(4_000));

    expect(longQuadraticMilliseconds / shortQuadraticMilliseconds).toBeGreaterThan(
      SUPERLINEAR_COST_RATIO_CEILING,
    );
  });

  it("retains nothing of the folds it has already produced", () => {
    // One fold before the baseline, dropped. Without it the first fold's one-time
    // costs — the projection's own module state, V8's compiled code for a path
    // nothing had exercised — would be reported as retention, which is a tier that
    // fails on first use of a feature rather than on a leak.
    const timeline = enduranceTimeline(ENDURANCE_ROW_COUNT);
    dropFoldOf(timeline);
    const baselineHeapBytes = settledHeapBytes();

    for (let foldIndex = 0; foldIndex < REPEATED_FOLD_COUNT; foldIndex += 1) {
      dropFoldOf(timeline);
    }
    const finalHeapBytes = settledHeapBytes();
    const retainedBytes = finalHeapBytes - baselineHeapBytes;

    process.stdout.write(
      `[console-endurance] ledger fold retention ${String(Math.round(retainedBytes / 1024))} kB ` +
        `over ${String(REPEATED_FOLD_COUNT)} folds of ${String(ENDURANCE_ROW_COUNT)} rows ` +
        `(ceiling ${String(Math.round(REPEATED_FOLD_RETENTION_CEILING_BYTES / 1024))} kB)\n`,
    );

    expect(retainedBytes).toBeLessThanOrEqual(REPEATED_FOLD_RETENTION_CEILING_BYTES);
  });

  it("negative control: a held window is large enough for the reading above to see one", () => {
    // The retention ceiling is only a gate if one leaked window would cross it. This
    // measures exactly that — the heap a single derived window occupies while it is
    // held — and asserts it is larger than the allowance, which is what makes the
    // case above sensitive rather than merely quiet.
    const timeline = enduranceTimeline(ENDURANCE_ROW_COUNT);
    const baselineHeapBytes = settledHeapBytes();
    const heldWindow = deriveLedgerWindow(timeline, false);
    const heldHeapBytes = settledHeapBytes();
    // Read through the held window AFTER the measurement, so it is unambiguously
    // still reachable at the moment the heap was sampled.
    expect(heldWindow.rows.length).toBeGreaterThan(0);

    const windowBytes = heldHeapBytes - baselineHeapBytes;
    process.stdout.write(
      `[console-endurance] one held ledger window ${String(Math.round(windowBytes / 1024))} kB ` +
        `at ${String(ENDURANCE_ROW_COUNT)} rows\n`,
    );
    expect(windowBytes).toBeGreaterThan(REPEATED_FOLD_RETENTION_CEILING_BYTES);
  });
});

/**
 * Fold once and keep nothing.
 *
 * A named function rather than an inline statement, because what matters is that no
 * binding outlives the call: a loop that assigned each window to a variable in the
 * enclosing scope would hold the last one alive, and the reading would then be
 * measuring the test rather than the ledger. The length is read so the fold cannot
 * be eliminated as dead.
 */
function dropFoldOf(timeline: readonly ConsoleSessionEvent[]): void {
  const rowCount = deriveLedgerWindow(timeline, false).rows.length;
  if (rowCount === 0) {
    throw new Error("the fold produced no rows, so nothing was measured");
  }
}
