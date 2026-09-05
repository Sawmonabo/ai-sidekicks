// The endurance tier's heap instrument: how it is read, and the proof it is one.
//
// Beside `console-workload.ts` rather than inside it, because the workload's job is
// to DRIVE the console — routes, scenario steps, store read-backs — and this one's is
// to measure it. They meet only at the tier's cases, which drive and then read.
//
// Both halves live here together, and that is the point: the reader's argument for
// why its figure is safe in one direction holds only at precise precision, and the
// assertion below is what establishes that precision was actually obtained. Split
// across two modules, the claim and its precondition would be two files apart.

import { expect } from "vitest";

import type { ConsoleApplication } from "../electron-harness.js";

/**
 * How many doubles the precision probe holds.
 *
 * A plain array assigned doubles is V8's packed-double backing store — eight bytes
 * an element, allocated once on the JS heap, with none of the copying a `push` loop
 * leaves behind. Half a million of them is four megabytes, which is the figure the
 * window below is drawn around.
 */
const PRECISION_PROBE_ELEMENT_COUNT = 500_000;

const PRECISION_PROBE_NOMINAL_BYTES = PRECISION_PROBE_ELEMENT_COUNT * 8;

/**
 * The window the probe's own growth has to land in.
 *
 * Both ends are the assertion, and each end rules out one way the default
 * instrument fails. BELOW: a reading served from Blink's long-interval cache does
 * not move at all, so the second read equals the first and the delta is zero.
 * ABOVE: a reading quantized onto Blink's bucket grid is one of a coarse set of
 * sizes whose smallest step is far larger than this probe, so it either does not
 * move or jumps a whole bucket — and a jump lands well past the ceiling.
 *
 * A window and not a floor, because a floor alone passes a quantized instrument
 * that happened to step a bucket, which is the failure this precondition exists
 * for. The ends are loose against the nominal figure so ordinary collector
 * activity between the two reads cannot decide the verdict.
 *
 * Measured rather than assumed: with the flag dropped from this tier's launch, the
 * same probe moved the reading by exactly 0 B (macOS, Electron 44, 2026-09-05) —
 * the cached form, reciting one value for both reads.
 */
const PRECISION_PROBE_MIN_OBSERVED_BYTES = PRECISION_PROBE_NOMINAL_BYTES / 2;

const PRECISION_PROBE_MAX_OBSERVED_BYTES = PRECISION_PROBE_NOMINAL_BYTES * 2;

/**
 * Prove `performance.memory` is measuring this renderer rather than reciting a
 * cached bucket.
 *
 * The tier's gated figures are DIFFERENCES of two heap readings taken seconds
 * apart — a pane's standing cost, a slope across instances, a teardown residue —
 * and every one of them is arithmetic on an instrument whose default form is
 * quantized and cached. A launch that lost `--enable-precise-memory-info` would not
 * fail loudly: it would report differences that are rounding, and the slope band
 * would swallow them.
 *
 * So the flag is not trusted. A known allocation is made between two reads and the
 * growth has to track it, which is a claim about the instrument rather than about
 * the console — and it is asserted by the cases that spend the instrument, not
 * inside the reader, so it costs one round trip per tier case rather than one per
 * sample.
 */
export async function expectPreciseHeapInstrument(
  consoleApplication: ConsoleApplication,
): Promise<void> {
  const probe = await consoleApplication.window.evaluate((elementCount: number) => {
    const readHeapBytes = (): number | null => {
      const memory = (
        performance as Performance & { readonly memory?: { readonly usedJSHeapSize: number } }
      ).memory;
      return memory === undefined ? null : memory.usedJSHeapSize;
    };
    const beforeBytes = readHeapBytes();
    const retained = new Array<number>(elementCount);
    for (let element = 0; element < elementCount; element += 1) {
      retained[element] = element + 0.5;
    }
    const afterBytes = readHeapBytes();
    // Read AFTER the second sample so the array is still reachable across it — a
    // probe V8 may collect before the reading it is the subject of proves nothing.
    return { beforeBytes, afterBytes, retainedCount: retained.length };
  }, PRECISION_PROBE_ELEMENT_COUNT);

  expect(
    probe.beforeBytes,
    "performance.memory is unavailable in this renderer; the endurance tier cannot measure a heap without it",
  ).not.toBeNull();
  expect(probe.retainedCount).toBe(PRECISION_PROBE_ELEMENT_COUNT);
  const observedBytes = Number(probe.afterBytes) - Number(probe.beforeBytes);
  expect(
    observedBytes,
    `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B allocation moved the renderer's heap reading by ` +
      `${String(observedBytes)} B, which is not a measurement of it — this launch is reading ` +
      "Blink's default quantized, cached MemoryInfo rather than the precise one",
  ).toBeGreaterThanOrEqual(PRECISION_PROBE_MIN_OBSERVED_BYTES);
  expect(observedBytes).toBeLessThanOrEqual(PRECISION_PROBE_MAX_OBSERVED_BYTES);
}

/**
 * Read the renderer's heap after asking it to collect.
 *
 * `--expose-gc` is not passed and deliberately not required: the reading is taken
 * as the MINIMUM over several samples with a yield between them, which lets the
 * incremental collector run and gives a floor that is far more stable than a
 * single sample.
 *
 * `usedJSHeapSize` counts what is allocated and not yet collected, so this figure
 * is at or above the retained heap it stands in for — which is the safe direction
 * for a ceiling: a budget satisfied by this reading is satisfied by the retained
 * heap too. THAT ARGUMENT IS ABOUT COLLECTOR LAG AND HOLDS ONLY AT PRECISE
 * PRECISION. At Blink's default the figure is quantized into buckets and served
 * from a long-interval cache, so it is neither a measurement of this instant nor
 * wrong in a known direction — a difference of two such readings is rounding in
 * both, and a fully cached one is a difference of zero. Every launch in this tier
 * therefore carries `isPreciseHeapReadingRequired`, and
 * {@link expectPreciseHeapInstrument} is what proves the flag arrived rather than
 * trusting that it did.
 */
export async function readSettledHeapBytes(
  consoleApplication: ConsoleApplication,
): Promise<number> {
  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < 6; sampleIndex += 1) {
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
      throw new Error(
        "performance.memory is unavailable in this renderer; the endurance tier cannot measure a heap without it",
      );
    }
    samples.push(sample);
  }
  return Math.min(...samples);
}
