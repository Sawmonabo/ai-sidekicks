// The pane-count sweep this row's slope is read over, and the rule that decides
// whether a sweep is admissible evidence at all.
//
// Split from `terminal-instance-memory.test.ts` for the reason the pane harness was
// split from it: that file is the budget row's ARGUMENT — what the subject is, what
// the figure covers, what fails the run — and this one is the measurement discipline
// the argument rests on. `terminal-pane-harness.ts` opens panes and proves each is
// drawing; this module reads the heap around them and says whether the readings
// agree well enough to be evidence.
//
// WHY A SWEEP IS RE-READ RATHER THAN TRUSTED
//
// Every figure here is a DIFFERENCE of two ~13 MB heap readings, and the quantity the
// slope control gates is a RATIO of two such differences. A sub-megabyte wobble in
// either reading moves that ratio by a factor of three. That is not a fault of the
// instrument — `RendererHeapProbe` forces a collection and takes a floor over
// settling samples, and `expectPreciseHeapInstrument` proves the reading is the
// precise one rather than Blink's quantized cache — it is what happens when a single
// sample is asked to carry a hard gate. Measured on a loaded machine: a first
// instance of 2 021 kB against a slope of 310 kB, a ratio of 0.15 against a 0.5
// floor, on a tree whose idle ratio is 0.87 run after run.
//
// So three things stand between a wobble and a red gate, and none of them widens the
// band: every reading is a MEDIAN over repeated settled reads, every per-instance
// interval is observed SEPARATELY and the intervals are held to each other, and a
// sweep that fails either test is re-measured exactly once before it fails the run.
//
// AND THE SENTENCE MATTERS AS MUCH AS THE BAND. The reason a sweep is inadmissible
// is carried out of here as operator-facing text, because the two ways to fail this
// control are not the same finding: a slope that is a small fraction of the first
// instance is a fixed cost being reported as an instance, and a figure inside the
// instrument's own noise is a reading that measured nothing. Renderer fallback is
// not among the candidates either sentence names — `openPaneAndAwaitWebglReadiness`
// fails the run before any reading is taken unless every instance reports `webgl`.

import type { ConsoleApplication } from "../electron-harness.js";
import type { RendererHeapProbe } from "./heap-instrument.js";
import { closeEveryPane, openPaneAndAwaitWebglReadiness } from "./terminal-pane-harness.js";

/**
 * How many instances the slope is read over.
 *
 * Three: one gives a delta and no slope, two give a slope from a single interval
 * whose noise is the whole reading, and three give two intervals whose agreement is
 * evidence — which is a claim this module has to earn by reading them separately,
 * and the reason `measureTerminalInstanceSeries` takes a reading after EVERY
 * instance rather than one at the end and a division. More would spend a WebGL
 * context per instance against a page ledger capped at twelve for reasons
 * `terminal/emulator/renderer-pool.ts` records.
 */
export const MEASURED_INSTANCE_COUNT: number = 3;

/**
 * How many settled reads each point of the sweep is the median of.
 *
 * Three, and it is a median rather than a mean because what it has to reject is one
 * outlying read — a collection that landed mid-sample, a background allocation in
 * the window — and a mean carries a third of that outlier into the figure while a
 * median of three discards it outright. Five would spend two more forced-collection
 * round trips per point to survive a SECOND outlier in the same triple, which is the
 * case the one re-measure below already covers, and it would do so at five times the
 * sweep's round-trip cost.
 *
 * Each read is itself `RendererHeapProbe.readSettledBytes` — four forced collections
 * and a floor over six settling samples — so this is a median over floors, not a
 * median over snapshots.
 */
export const HEAP_READING_SAMPLE_COUNT: number = 3;

/**
 * The smallest per-instance figure this sweep will treat as a measurement.
 *
 * An ABSOLUTE floor beside the ratio band, because a ratio says nothing about
 * whether either of its terms was real. Measured idle on macOS / Electron 44 over
 * five runs, the three per-instance figures land at 937-942 kB for the first
 * instance and 824-827 kB for each later one; the same sweep on a loaded machine
 * produced a 310 kB later-instance figure. 200 kB is under a quarter of the smallest
 * honest reading and well over the few-kilobyte drift between two settled reads of
 * an unchanged page, so a figure below it is a difference the instrument cannot
 * resolve rather than a pane that got cheaper.
 *
 * A figure under this floor is reported as instrument noise and never as a fixed
 * cost: this sweep cannot tell a per-instance cost that collapsed from a heap
 * reading that wobbled, and saying the first when the second is true sends a
 * reviewer to the console for a defect that is on the runner.
 */
export const INSTRUMENT_NOISE_FLOOR_BYTES: number = 200 * 1024;

/**
 * How far the later instances' slope may sit from the first instance's delta.
 *
 * A FACTOR rather than a byte figure, because a tolerance tight enough to mean
 * something at this revision's ~940 kB pane reading would be inside the noise once
 * the output stream lands and the same pane holds a filled buffer.
 *
 * The LOWER bound is the load-bearing half and the reason this control exists: a
 * first delta inflated by a one-time cost — the emulator chunk, a lazily created
 * texture atlas, a page-wide allocation the second instance reuses — shows up as a
 * slope that is a small FRACTION of it, which is precisely the shape of "a fixed
 * cost reported as the instance". That is not hypothetical here: before the readings
 * were taken behind a forced collection, this run measured a first instance at
 * 4 165 kB and a slope of MINUS 5 765 kB, because a later mount triggered the
 * collection the baseline had not had. The upper bound catches the mirror image — a
 * first instance costing less than its successors, which would mean the gated figure
 * is not the worst case it claims to be.
 *
 * The band is wide against what the instrument delivers idle: a first instance of
 * 937-942 kB against a slope of 824-827 kB, a ratio that read 0.88 in every one of
 * five runs. The absolute figures move by a few kilobytes between runs and the RATIO
 * does not, which is the quantity this control is about. The width is headroom for a
 * different runner's allocator rather than slack this reading needs.
 *
 * Read against the PANE half alone, deliberately. The slope is a claim about what a
 * second pane costs, and the scrollback half is measured once for the subject rather
 * than per mounted instance.
 */
export const SLOPE_AGREEMENT_LOWER_FACTOR: number = 0.5;
export const SLOPE_AGREEMENT_UPPER_FACTOR: number = 2;

/**
 * How far the per-instance intervals may sit from each other.
 *
 * The band above compares a MEAN of the later intervals against the first instance,
 * and a mean hides the disagreement that would discredit it: a run where instance 2
 * costs 1.5 MB and instance 3 costs 0.1 MB averages to a healthy-looking slope. So
 * the intervals are also held to one another — the smaller must be at least this
 * fraction of the larger — which is what makes "two intervals whose agreement is
 * itself evidence" a check rather than a hope.
 *
 * The same 0.5 as the slope band's lower bound, and for the same reason: two
 * measurements of one quantity that disagree by more than a factor of two are not
 * two measurements of one quantity. Idle, the two intervals differ by under 1 %.
 */
export const INTERVAL_AGREEMENT_LOWER_FACTOR: number = 0.5;

/**
 * How much of one pane's cost may still be held after every pane is closed.
 *
 * One pane's own figure. Three came and went, so a per-instance retention would show
 * three times over; anything under one instance cannot be a per-instance leak. The
 * claim is deliberately the weaker one — this row owns the pane-shaped teardown, and
 * the adapter's own churn accounting over a working day of cycles is
 * `terminal-endurance.test.ts`'s and is not duplicated here.
 *
 * Scaled by {@link TerminalInstanceSeries.perInstanceBytes} and never by the first
 * instance's delta alone. Both bounds used to hang off that one difference, so a
 * single under-read tightened the residue bound in the same run that made the slope
 * fail, and one wobble failed two controls as if they were two findings.
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

function medianOf(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[ordered.length % 2 === 0 ? middle - 1 : middle] ?? 0;
  const upper = ordered[middle] ?? 0;
  return (lower + upper) / 2;
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
 * Open the instances one at a time, reading the settled heap around every one, and
 * close them all again.
 *
 * Self-contained on both ends: it takes its own baseline with nothing mounted and
 * leaves the page with nothing mounted, which is what lets a caller run it a second
 * time without unwinding anything of its own. The warm-up cycle that moves the
 * emulator chunk to the left of the baseline is the CALLER's, because it is paid
 * once for the page and a second sweep must not pay it again.
 */
export async function measureTerminalInstanceSeries(
  consoleApplication: ConsoleApplication,
  heapProbe: RendererHeapProbe,
): Promise<TerminalInstanceSeries> {
  const baselineHeapBytes = await readMedianSettledBytes(heapProbe);

  await openPaneAndAwaitWebglReadiness(consoleApplication, 1);
  const oneInstanceHeapBytes = await readMedianSettledBytes(heapProbe);
  const paneStandingBytes = oneInstanceHeapBytes - baselineHeapBytes;

  const perInstanceIntervalBytes: number[] = [];
  let previousHeapBytes = oneInstanceHeapBytes;
  for (let instance = 2; instance <= MEASURED_INSTANCE_COUNT; instance += 1) {
    await openPaneAndAwaitWebglReadiness(consoleApplication, instance);
    const heapBytes = await readMedianSettledBytes(heapProbe);
    perInstanceIntervalBytes.push(heapBytes - previousHeapBytes);
    previousHeapBytes = heapBytes;
  }

  await closeEveryPane(consoleApplication, MEASURED_INSTANCE_COUNT);
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
 * Three tests, in the order a reader needs them. The floor first, because a ratio
 * between two figures the instrument could not resolve says nothing at all; then the
 * intervals against each other, because a mean of two disagreeing intervals is not a
 * slope; then the slope against the first instance, which is the finding this
 * control exists for.
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
