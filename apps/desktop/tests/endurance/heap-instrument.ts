// The endurance tier's heap instrument: how the heap is read, and the proof that the
// instrument is precise. It sits beside `endurance-workload.ts`, which drives the console.
//
// The reader's figure is safe in one direction only at precise precision, so the reader and the
// assertion that establishes precision live together. The proof allocates four megabytes that
// are unreachable once it returns, so a sampler reading taken next could carry up to four
// megabytes of the proof itself. The tier therefore has one reader, `RendererHeapProbe`, which
// collects first; the sampler under it is module-private.

import { expect } from "vitest";

import type { CDPSession } from "@playwright/test";

import type { AppUnderTest } from "../helpers/electron-harness.js";
import { SETTLE_ROUNDS } from "./heap-sampling.js";
import {
  captureHeapSnapshot,
  retainedByConstructor,
  type RetainedConstructorReading,
} from "./heap-snapshot-analysis.js";

/**
 * What the precision probe weighs, and the length of the string that weighs it.
 *
 * One number for both: a flat one-byte string makes size and length the same figure, and it
 * depends on no elements kind that could transition. A numeric array is not used: growing it
 * swaps its backing store and both are counted until a collection runs (8,022,500 B on the
 * ubuntu runner, -38,965,632 B when a collection landed in the window). Exported so the control
 * that plants a same-shaped allocation shares the size.
 */
export const PRECISION_PROBE_NOMINAL_BYTES: number = 4_000_000;

/**
 * The character the probe's string is made of.
 *
 * Exported with the size so the control's plant has the same shape; a two-byte character would
 * break the one-byte-per-character identity. Callers pass it as an argument because a function
 * handed to `page.evaluate` is serialized by source and captures no closure.
 */
export const PRECISION_PROBE_FILL_CHARACTER: string = "x";

/**
 * How far either end of the window sits from the payload: 64 KiB.
 *
 * Above, V8's overhead measured 560 B per collected window (1,852 B in a session's first) on
 * macOS / Electron 44; the rest is room for another platform's header width or alignment. Below,
 * a collection netting bytes out inside the window can pull the difference under the payload
 * (widest excursion measured: 6,684 B). A second backing store overshoots by four megabytes and
 * an unflattened payload undershoots by nearly all of it, so the width stays far inside both.
 */
const PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES = 65_536;

/**
 * The window the probe's growth must land in: the payload plus or minus the allowance.
 *
 * Symmetric because the quantity is a difference of two readings, which falls under the payload
 * when a collection nets bytes out (one uncollected window read 3,993,316 B). The default
 * instrument read 0 B in twelve windows with the flag dropped (macOS, Electron 44), so the floor
 * of 3,934,464 B rejects it; `heap-instrument.test.ts` asserts the refusal. The ceiling turns
 * "the reading moved" into "the reading measured this". It does not rule out a quantized
 * instrument stepping inside the band on a large heap; the cache serving one value to both reads
 * is what fails the coarse launch.
 */
const PRECISION_PROBE_MIN_OBSERVED_BYTES =
  PRECISION_PROBE_NOMINAL_BYTES - PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES;

const PRECISION_PROBE_MAX_OBSERVED_BYTES =
  PRECISION_PROBE_NOMINAL_BYTES + PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES;

/**
 * How many windows the probe takes; the median is the reading.
 *
 * Contamination runs both ways: a collection between the reads lowers the difference, anything
 * allocating into the window raises it, so a maximum is defenseless against the second. A
 * median discards one outlier at either end and three is the smallest count that survives one.
 * Fourteen uncollected windows on one launch read 4,000,560 B nine times, the rest scattered
 * from -40,452,864 B to 4,001,852 B. The probe's own windows read 4,001,852 B, 4,000,560 B,
 * 4,000,560 B on every launch: the first evaluate of a session keeps an extra 1,292 B.
 */
const PRECISION_PROBE_WINDOW_COUNT = 3;

/**
 * The median of a small set of heap readings, averaging the two middle values on an even count.
 *
 * Shared by the precision proof and `terminal-instance-series.ts`. `frame-time.test.ts` keeps
 * its own nearest-rank median, since folding it in would change the statistic it reports.
 */
export function medianOfHeapReadings(readings: readonly number[]): number {
  const ordered = [...readings].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[ordered.length % 2 === 0 ? middle - 1 : middle] ?? 0;
  const upper = ordered[middle] ?? 0;
  return (lower + upper) / 2;
}

/**
 * Returns the sentence to raise when the probe windows are not a measurement of the probe's own
 * allocation, or `null` when they are.
 *
 * Separate from the launch so `heap-instrument.test.ts` can drive the band and the median over
 * readings a live launch cannot be made to produce. A string rather than a boolean, so a caller
 * that asserts on it prints the refusal itself.
 */
export function precisionProbeRefusalFor(observedBytesPerWindow: readonly number[]): string | null {
  const observedBytes = medianOfHeapReadings(observedBytesPerWindow);
  const observedWindowsText = observedBytesPerWindow.map((bytes) => String(bytes)).join(", ");
  const preamble =
    `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B allocation moved the renderer's heap reading ` +
    `by ${String(observedBytes)} B (windows: ${observedWindowsText}), which is `;
  if (observedBytes < PRECISION_PROBE_MIN_OBSERVED_BYTES) {
    // Two causes, and the message names both because the assertion cannot tell them apart: the
    // flattening this probe relies on is V8's current behavior, and a rope reaches this end the
    // same way a lost launch flag does.
    return (
      `${preamble}less than the allocation weighs — either this launch lost ` +
      "`--enable-precise-memory-info` and is reading Blink's default quantized, cached " +
      "MemoryInfo, or the payload reached the second read unflattened"
    );
  }
  if (observedBytes > PRECISION_PROBE_MAX_OBSERVED_BYTES) {
    return (
      `${preamble}more than the allocation weighs — the reading is carrying something other ` +
      "than this probe's own string, so a difference taken with it is not a measurement of " +
      "what was allocated between two reads"
    );
  }
  return null;
}

/**
 * How many settling samples the minimum below is taken over.
 *
 * Samples are two animation frames and a macrotask apart, so six give the collector five
 * chances to run and the smallest is what the heap settled to. Distinct from `SETTLE_ROUNDS`,
 * which counts forced collections.
 */
const SETTLING_SAMPLE_COUNT = 6;

/**
 * The sentence raised when `performance.memory` is missing, whichever of the probe's
 * expectation and the sampler finds it first.
 */
const HEAP_INSTRUMENT_UNAVAILABLE =
  "performance.memory is unavailable in this renderer; the endurance tier cannot measure a heap without it";

/**
 * Proves `performance.memory` is measuring this renderer rather than reciting a cached bucket.
 *
 * Every gated figure is a difference of heap readings and the default instrument is quantized
 * and cached, so a launch that lost `--enable-precise-memory-info` would report rounding that
 * the slope band swallows. An allocation of a size known here is made between two reads and the
 * growth must land in the window around that size. Cases call it once each, not around every
 * reading: it takes three windows, each a forced collection plus one evaluate.
 *
 * Each window is taken behind a forced collection, since an uncollected one reports what the
 * collector reclaimed inside it (-40,452,864 B once); the probe is an argument so the proof and
 * the readings it guards use the same collector. It leaves one unreachable payload behind, so
 * the next reading must go through `RendererHeapProbe`, which collects before it reads.
 */
export async function expectPreciseHeapInstrument(
  consoleApplication: AppUnderTest,
  heapProbe: RendererHeapProbe,
): Promise<void> {
  const observedBytesPerWindow: number[] = [];
  for (let windowIndex = 0; windowIndex < PRECISION_PROBE_WINDOW_COUNT; windowIndex += 1) {
    await heapProbe.collectGarbage();
    const probe = await consoleApplication.window.evaluate(
      ([characterCount, fillCharacter]: [number, string]) => {
        const readHeapBytes = (): number | null => {
          const memory = (
            performance as Performance & { readonly memory?: { readonly usedJSHeapSize: number } }
          ).memory;
          return memory === undefined ? null : memory.usedJSHeapSize;
        };
        const beforeBytes = readHeapBytes();
        const retained = fillCharacter.repeat(characterCount);
        // The repeat answers a rope of concatenation cells weighing a few hundred bytes. V8's
        // character accessor flattens its receiver before indexing, which makes the one
        // sequential string; that is engine behavior, not a guarantee, so the window's floor is
        // the evidence (an unflattened rope measured 548 B). The result is returned because an
        // unconsumed indexing read is elidable.
        const lastCharacterCode = retained.charCodeAt(characterCount - 1);
        const afterBytes = readHeapBytes();
        // Read after the second sample so the string is still reachable across it.
        return { beforeBytes, afterBytes, retainedLength: retained.length, lastCharacterCode };
      },
      [PRECISION_PROBE_NOMINAL_BYTES, PRECISION_PROBE_FILL_CHARACTER] as [number, string],
    );

    expect(probe.beforeBytes, HEAP_INSTRUMENT_UNAVAILABLE).not.toBeNull();
    expect(probe.retainedLength).toBe(PRECISION_PROBE_NOMINAL_BYTES);
    expect(probe.lastCharacterCode).toBe(PRECISION_PROBE_FILL_CHARACTER.charCodeAt(0));
    observedBytesPerWindow.push(Number(probe.afterBytes) - Number(probe.beforeBytes));
  }

  // Raised as the failure's own message rather than asserted as a value: vitest elides a
  // compared value past its print width, which would hide the reading and the cause.
  const refusal = precisionProbeRefusalFor(observedBytesPerWindow);
  if (refusal !== null) {
    expect.fail(refusal);
  }
}

/**
 * Reads the renderer's heap as the minimum over settling samples.
 *
 * Module-private because a sampler forces no collection; its only caller is
 * `RendererHeapProbe`, which collects first. `usedJSHeapSize` counts allocated and not yet
 * collected bytes, so the figure is at or above the retained heap, the safe direction for a
 * ceiling. That holds only at precise precision: Blink's default is quantized and cached, which
 * is why every launch carries `isPreciseHeapReadingRequired` and
 * {@link expectPreciseHeapInstrument} proves it arrived.
 */
async function readSettledHeapBytes(consoleApplication: AppUnderTest): Promise<number> {
  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < SETTLING_SAMPLE_COUNT; sampleIndex += 1) {
    const sample = await consoleApplication.window.evaluate(async () => {
      // Two frames plus a macrotask: enough for the collector to run its
      // incremental steps between samples without pinning the main thread.
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 0);
          });
        });
      });
      const memory = (
        performance as Performance & { readonly memory?: { readonly usedJSHeapSize: number } }
      ).memory;
      return memory === undefined ? null : memory.usedJSHeapSize;
    });
    if (sample === null) {
      throw new Error(HEAP_INSTRUMENT_UNAVAILABLE);
    }
    samples.push(sample);
  }
  return Math.min(...samples);
}

/**
 * The renderer's heap, read after its garbage has been collected.
 *
 * The sampler's minimum is only as good as what the incremental collector reached. Without the
 * collection, the first pane's mount left the emulator chunk's allocations uncollected and a
 * later major collection made the second instance read -5.8 MB against a real cost of about
 * 4 MB. Collection goes over a DevTools session rather than `--js-flags=--expose-gc`, which
 * would change what every file sharing the launcher measures.
 */
export class RendererHeapProbe {
  readonly #consoleApplication: AppUnderTest;
  readonly #cdpSession: CDPSession;

  private constructor(consoleApplication: AppUnderTest, cdpSession: CDPSession) {
    this.#consoleApplication = consoleApplication;
    this.#cdpSession = cdpSession;
  }

  public static async attachTo(consoleApplication: AppUnderTest): Promise<RendererHeapProbe> {
    const cdpSession = await consoleApplication.application
      .context()
      .newCDPSession(consoleApplication.window);
    return new RendererHeapProbe(consoleApplication, cdpSession);
  }

  /**
   * Collects and lets pending finalization run.
   *
   * The round count is `SETTLE_ROUNDS` from `heap-sampling.ts`, so a change there moves this
   * loop too. Public because {@link expectPreciseHeapInstrument} needs exactly this collection:
   * over an uncollected heap its difference would include what the collector reclaimed.
   */
  public async collectGarbage(): Promise<void> {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      await this.#cdpSession.send("HeapProfiler.collectGarbage");
      await this.#consoleApplication.window.evaluate(
        async () =>
          new Promise((resolve) => {
            setTimeout(resolve, 0);
          }),
      );
    }
  }

  /** Collect, let finalization run, and read the settled heap. */
  public async readSettledBytes(): Promise<number> {
    await this.collectGarbage();
    return readSettledHeapBytes(this.#consoleApplication);
  }

  /**
   * Collects, then writes a heap snapshot of this window to `snapshotPath`.
   *
   * On the probe so the snapshot uses the same DevTools session as every reading; it collects
   * first because an uncollected snapshot attributes unreachable objects to their last referrer.
   */
  public async captureSnapshotTo(snapshotPath: string): Promise<void> {
    await this.#cdpSession.send("HeapProfiler.collectGarbage");
    await captureHeapSnapshot(this.#cdpSession, snapshotPath);
  }

  /** What the named constructors retained in a snapshot this probe wrote. */
  public async readRetainedByConstructor(
    snapshotPath: string,
    constructorNames: readonly string[],
  ): Promise<readonly RetainedConstructorReading[]> {
    return retainedByConstructor(snapshotPath, constructorNames);
  }

  public async detach(): Promise<void> {
    await this.#cdpSession.detach();
  }
}
