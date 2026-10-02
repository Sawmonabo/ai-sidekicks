// The pane-count sweep the row's slope is read over, and the rule that decides whether a sweep
// is admissible evidence.
//
// `terminal-instance-memory.test.ts` is the budget row's argument (what the subject is, what
// the figure covers, what fails the run); this is the measurement discipline it rests on.
// `terminal-pane-harness.ts` opens panes and proves each is drawing; this module reads the heap
// around them and says whether the readings agree well enough to be evidence.
//
// A sweep is re-read rather than trusted: every figure is a difference of two ~13 MB heap
// readings and the slope control gates a ratio of two such differences, so a sub-megabyte wobble
// moves the ratio by a factor of three. `RendererHeapProbe` forces a collection and
// `expectPreciseHeapInstrument` proves precision, but one sample still cannot carry a hard gate.
// Measured on a loaded machine: a first instance of 2 021 kB against a slope of 310 kB, a ratio
// of 0.15 against a 0.5 floor, where the idle ratio is 0.87 run after run.
//
// Three things stand between a wobble and a red gate, none widening the band: every reading is a
// median over repeated settled reads, every per-instance interval is observed separately and the
// intervals are held to each other, and a sweep that fails either test is re-measured once
// before it fails the run.
//
// The reason a sweep is inadmissible is text for the person, because the failures are different
// findings: a slope that is a small fraction of the first instance is a fixed cost reported as
// an instance, and a figure inside the instrument's noise measured nothing. Renderer fallback is
// not a candidate either sentence names, since `openPaneAndAwaitWebglReadiness` fails the run
// before any reading unless every instance reports `webgl`.

import type { AppUnderTest } from "../helpers/electron-harness.js";
import { medianOf } from "../helpers/sample-statistics.js";
import type { RendererHeapProbe } from "./heap-instrument.js";
import { closeEveryPane, openPaneAndAwaitWebglReadiness } from "./terminal-pane-harness.js";

/**
 * How many instances the slope is read over.
 *
 * Three: one gives a delta and no slope, two give a slope from a single interval whose noise is
 * the whole reading, and three give two intervals whose agreement is evidence, hence a reading
 * after every instance in `measureTerminalInstanceSeries`. More would spend a WebGL context per
 * instance against a page cap of twelve contexts (see `terminal/emulator/renderer-pool.ts`).
 */
export const MEASURED_INSTANCE_COUNT: number = 3;

/**
 * How many settled reads each point of the sweep is the median of.
 *
 * A median because the aim is to reject one outlying read (a collection landing mid-sample, a
 * background allocation): a mean carries a third of it into the figure, a median of three
 * discards it. Five would cost two more forced-collection round trips per point to survive a
 * second outlier in the same triple, which the one re-measure already covers. Each read is
 * `RendererHeapProbe.readSettledBytes`, so this is a median over floors, not over snapshots.
 * The median is `medianOf` from `sample-statistics.ts`, shared with the precision proof.
 */
export const HEAP_READING_SAMPLE_COUNT: number = 3;

/**
 * The smallest per-instance figure this sweep will treat as a measurement.
 *
 * An absolute floor beside the ratio band, since a ratio says nothing about whether either term
 * was real. Idle on macOS / Electron 44 over five runs, the first instance measured 937-942 kB
 * and each later one 824-827 kB; a loaded machine produced a 310 kB later-instance figure.
 * 200 kB is under a quarter of the smallest honest reading and well over the few-kilobyte drift
 * between two settled reads of an unchanged page. A figure below it is reported as instrument
 * noise, never as a fixed cost: the sweep cannot tell a collapsed per-instance cost from a
 * wobbling heap reading, and saying the first sends a reviewer to the app for a defect on
 * the runner.
 */
export const INSTRUMENT_NOISE_FLOOR_BYTES: number = 200 * 1024;

/**
 * How far the later instances' slope may sit from the first instance's delta.
 *
 * A factor rather than a byte figure, since a tolerance tight enough to mean something at the
 * ~940 kB pane reading would fall inside the noise once the pane holds a filled buffer. The
 * lower bound is the load-bearing half: a first delta inflated by a one-time cost (the emulator
 * chunk, a lazily created texture atlas) makes the slope a small fraction of it. Before
 * readings were taken behind a forced collection, the run measured a first instance of
 * 4 165 kB and a slope of minus 5 765 kB, because a later mount triggered the collection the
 * baseline lacked. The upper bound catches the mirror image: a first instance costing less than
 * its successors would mean the gated figure is not the worst case. Idle, the ratio read 0.88 in
 * five runs (937-942 kB against 824-827 kB); the width is headroom for a different runner's
 * allocator. Read against the pane half alone: the slope is about what a second pane costs.
 */
export const SLOPE_AGREEMENT_LOWER_FACTOR: number = 0.5;

/** The upper bound of the slope band: later panes may cost at most this multiple of the first. */
export const SLOPE_AGREEMENT_UPPER_FACTOR: number = 2;

/**
 * How far the per-instance intervals may sit from each other: the smaller must be at least this
 * fraction of the larger.
 *
 * The slope band compares a mean of the later intervals with the first instance, and a mean
 * hides disagreement (1.5 MB and 0.1 MB average to a healthy-looking slope). The same 0.5 as
 * the slope band's lower bound: two measurements of one quantity that differ by more than a
 * factor of two are not two measurements of one quantity. Idle, the intervals differ by under 1 %.
 */
export const INTERVAL_AGREEMENT_LOWER_FACTOR: number = 0.5;

/**
 * How much of one pane's cost may still be held after every pane is closed.
 *
 * One pane's own figure: three came and went, so a per-instance retention would show three times
 * over. The claim is deliberately the weaker one; this row owns the pane-shaped teardown, and
 * the adapter's churn accounting is `xterm-adapter.test.ts`'s. Scaled by
 * {@link TerminalInstanceSeries.perInstanceBytes} and never by the first delta alone, so one
 * under-read cannot tighten this bound in the same run that fails the slope.
 */
export const TEARDOWN_RESIDUE_FACTOR: number = 1;

/** One pane-count sweep: what each instance cost, and what came back. */
export interface TerminalInstanceSeries {
  /** The settled heap with no pane mounted, after the warm-up cycle. */
  readonly baselineHeapBytes: number;
  /** What the FIRST mounted pane added to that baseline. */
  readonly paneStandingBytes: number;
  /** What each later instance added, observed one instance at a time. */
  readonly perInstanceIntervalBytes: readonly number[];
  /** The later instances' mean cost — the slope the band above is read on. */
  readonly laterInstanceBytes: number;
  /** This sweep's per-instance cost over all three observations of it. */
  readonly perInstanceBytes: number;
  /** What the page still held once every pane was closed. */
  readonly teardownResidueBytes: number;
}

/** Whether a sweep is evidence, and the sentence when it is not. */
export type SeriesAdmissibility =
  | { readonly admissible: true }
  | { readonly admissible: false; readonly reason: string };

function kilobytes(bytes: number): string {
  return `${String(Math.round(bytes / 1024))} kB`;
}

/** One point of the sweep: the median of {@link HEAP_READING_SAMPLE_COUNT} reads. */
async function readMedianSettledBytes(heapProbe: RendererHeapProbe): Promise<number> {
  const reads: number[] = [];
  for (let sample = 0; sample < HEAP_READING_SAMPLE_COUNT; sample += 1) {
    reads.push(await heapProbe.readSettledBytes());
  }
  return medianOf(reads);
}

/**
 * Opens the instances one at a time, reading the settled heap around each, and closes them all.
 *
 * Self-contained on both ends (its own baseline with nothing mounted, nothing mounted after), so
 * a caller can run it twice. The warm-up cycle that moves the emulator chunk left of the
 * baseline is the caller's, since it is paid once for the page.
 */
export async function measureTerminalInstanceSeries(
  appUnderTest: AppUnderTest,
  heapProbe: RendererHeapProbe,
): Promise<TerminalInstanceSeries> {
  const baselineHeapBytes = await readMedianSettledBytes(heapProbe);

  await openPaneAndAwaitWebglReadiness(appUnderTest, 1);
  const oneInstanceHeapBytes = await readMedianSettledBytes(heapProbe);
  const paneStandingBytes = oneInstanceHeapBytes - baselineHeapBytes;

  const perInstanceIntervalBytes: number[] = [];
  let previousHeapBytes = oneInstanceHeapBytes;
  for (let instance = 2; instance <= MEASURED_INSTANCE_COUNT; instance += 1) {
    await openPaneAndAwaitWebglReadiness(appUnderTest, instance);
    const heapBytes = await readMedianSettledBytes(heapProbe);
    perInstanceIntervalBytes.push(heapBytes - previousHeapBytes);
    previousHeapBytes = heapBytes;
  }

  await closeEveryPane(appUnderTest, MEASURED_INSTANCE_COUNT);
  const afterTeardownHeapBytes = await readMedianSettledBytes(heapProbe);

  const everyInstanceBytes = [paneStandingBytes, ...perInstanceIntervalBytes];
  return {
    baselineHeapBytes,
    paneStandingBytes,
    perInstanceIntervalBytes,
    laterInstanceBytes:
      perInstanceIntervalBytes.reduce((total, interval) => total + interval, 0) /
      perInstanceIntervalBytes.length,
    perInstanceBytes:
      everyInstanceBytes.reduce((total, instance) => total + instance, 0) /
      everyInstanceBytes.length,
    teardownResidueBytes: Math.max(0, afterTeardownHeapBytes - baselineHeapBytes),
  };
}

/**
 * Whether this sweep's readings are evidence about a pane.
 *
 * Three tests in order: the floor (a ratio between figures the instrument could not resolve says
 * nothing), the intervals against each other (a mean of disagreeing intervals is not a slope),
 * then the slope against the first instance.
 */
export function admissibilityOf(series: TerminalInstanceSeries): SeriesAdmissibility {
  const everyInstanceBytes = [series.paneStandingBytes, ...series.perInstanceIntervalBytes];
  const observed =
    `first instance ${kilobytes(series.paneStandingBytes)}, later instances ` +
    `[${series.perInstanceIntervalBytes.map(kilobytes).join(", ")}]`;

  if (everyInstanceBytes.some((instance) => instance < INSTRUMENT_NOISE_FLOOR_BYTES)) {
    return {
      admissible: false,
      reason:
        `${observed} — at least one figure is under this instrument's ` +
        `${kilobytes(INSTRUMENT_NOISE_FLOOR_BYTES)} noise floor. Each is a difference of two ` +
        "~13 MB heap readings, so this sweep cannot tell a per-instance cost that collapsed " +
        "from a heap reading that wobbled; a loaded machine is the likeliest cause. Renderer " +
        "fallback is not a candidate — every instance was proved to report `webgl` before any " +
        "reading was taken.",
    };
  }

  const smallestInterval = Math.min(...series.perInstanceIntervalBytes);
  const largestInterval = Math.max(...series.perInstanceIntervalBytes);
  if (smallestInterval < largestInterval * INTERVAL_AGREEMENT_LOWER_FACTOR) {
    return {
      admissible: false,
      reason:
        `${observed} — the per-instance intervals disagree with each other by more than a ` +
        `factor of ${String(1 / INTERVAL_AGREEMENT_LOWER_FACTOR)}, so their mean is not a slope. ` +
        "Two readings of one quantity that far apart are two different measurements, and this " +
        "sweep cannot say which of them priced a pane.",
    };
  }

  if (series.laterInstanceBytes < series.paneStandingBytes * SLOPE_AGREEMENT_LOWER_FACTOR) {
    return {
      admissible: false,
      reason:
        `${observed} — the later panes cost a fraction of the first one, so the gated figure is ` +
        "dominated by a cost that is paid once rather than per instance.",
    };
  }

  if (series.laterInstanceBytes > series.paneStandingBytes * SLOPE_AGREEMENT_UPPER_FACTOR) {
    return {
      admissible: false,
      reason:
        `${observed} — the later panes cost more than the first one, so the gated figure is not ` +
        "the worst case this row claims to bound.",
    };
  }

  return { admissible: true };
}
