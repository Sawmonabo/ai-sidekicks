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
//
// AND THE PRECONDITION MUST NOT ENTER THE FIGURE IT IS A PRECONDITION FOR. Proving
// the instrument costs a four-megabyte allocation, and that allocation is unreachable
// the instant the probe returns — so a reading taken next, by a sampler that forces
// no collection, can carry up to four megabytes of the proof itself. Subtracted from
// a difference gated at eight, that is half the allowance spent on the measurement's
// own scaffolding, and reclaimed mid-run it comes back as growth the gate cannot see.
// So the tier has ONE reader, `RendererHeapProbe`, which collects first; the sampler
// under it is module-private and reachable through nothing else. The class moved here
// from `terminal-pane-harness.ts` when the second and third callers appeared: it is a
// reading of the renderer's heap and not of a terminal pane, and one home per role is
// what keeps the two tiers' figures the same kind of figure.

import { expect } from "vitest";

import type { CDPSession } from "@playwright/test";

import type { ConsoleApplication } from "../electron-harness.js";
import { SETTLE_ROUNDS } from "../heap-sampling.js";

/**
 * How many doubles the precision probe holds.
 *
 * A plain array assigned doubles is V8's packed-double backing store — eight bytes
 * an element, allocated once on the JS heap, with none of the copying a `push` loop
 * leaves behind. Half a million of them is four megabytes, which is the figure the
 * window below is drawn around.
 *
 * Exported beside the nominal it produces so the control that proves the collection
 * happened plants an allocation of the same shape and the same size, rather than
 * re-deriving one from a bytes-per-double this module would then own in two places.
 */
export const PRECISION_PROBE_ELEMENT_COUNT: number = 500_000;

/**
 * What the precision probe weighs, and the size a case planting its own retained
 * allocation against this instrument should reach for.
 *
 * Exported because the control that proves the collection happened has to plant a
 * figure of a known size, and a second nominal written into that file would be a
 * second answer to how big "big enough to see" is.
 */
export const PRECISION_PROBE_NOMINAL_BYTES: number = PRECISION_PROBE_ELEMENT_COUNT * 8;

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
 * How many settling samples the minimum below is taken over.
 *
 * Named rather than spelled in the loop, on this package's rule that a cap carries
 * its rationale. Six is what a reading needs to be a FLOOR rather than a snapshot:
 * each sample is separated from the last by two animation frames and a macrotask, so
 * the collector gets five chances to run between the first and the last, and the
 * smallest of the six is what the heap actually settled to. Distinct from
 * `SETTLE_ROUNDS`, which counts forced collections and not samples — the two answer
 * different questions and neither can stand in for the other.
 */
const SETTLING_SAMPLE_COUNT = 6;

/**
 * The one sentence both arms say when the instrument is not there at all.
 *
 * Written once because it is operator-facing and the two arms that raise it — an
 * expectation on the probe's first read and a throw inside the sampler — are the
 * same finding reported from two places. Two copies drift, and the drift is
 * invisible: whichever arm fires is the only one anybody reads.
 */
const HEAP_INSTRUMENT_UNAVAILABLE =
  "performance.memory is unavailable in this renderer; the endurance tier cannot measure a heap without it";

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
 *
 * IT LEAVES ITS OWN FOUR MEGABYTES BEHIND, unreachable and uncollected. Every caller
 * therefore takes its next reading through {@link RendererHeapProbe}, which collects
 * before it reads; a sampler-only reading taken here would carry the proof into the
 * figure the proof exists to make trustworthy.
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

  expect(probe.beforeBytes, HEAP_INSTRUMENT_UNAVAILABLE).not.toBeNull();
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
 * Read the renderer's heap as the minimum over settling samples.
 *
 * MODULE-PRIVATE, and that is the fix rather than a tidying: a sampler forces no
 * collection, so what it answers depends on whether V8 happened to run one — and
 * every reading this tier gates on is taken a few round trips after a precondition
 * that leaves four megabytes of unreachable array behind. Exported, it was reached
 * directly by the two cases that could least afford it. The only caller now is
 * {@link RendererHeapProbe}, which collects first, so there is no call shape left
 * that takes an uncollected reading.
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
async function readSettledHeapBytes(consoleApplication: ConsoleApplication): Promise<number> {
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
 * The renderer's heap, read after its garbage has actually been collected.
 *
 * WHY A FORCED COLLECTION AND NOT THE SAMPLER ALONE. The sampler takes the minimum
 * over settling samples, which lets the incremental collector run and gives a floor —
 * but a floor is only as good as what the collector happened to reach, and every
 * figure this tier gates is either a DIFFERENCE of two readings or a ceiling taken a
 * few round trips after a four-megabyte precondition. Measured on this code without
 * the collection: the first pane's mount leaves the emulator chunk's own allocations
 * uncollected, a later mount triggers a major collection that reclaims them, and the
 * second instance reads as NEGATIVE — minus 5.8 MB per instance, against a real
 * per-instance cost of about 4 MB. The sampling discipline is kept and a collection
 * is put in front of it, which is exactly what `test/console/heap-sampling.ts` does
 * for the two tiers that measure in process.
 *
 * WHY CDP AND NOT `--js-flags=--expose-gc`. The flag would have to be passed at
 * launch, and the launcher is shared with every other file in this tier and with
 * the end-to-end tier — so one file's instrument would change what all of them
 * measure. A DevTools session is scoped to this run and to this window, and
 * `HeapProfiler.collectGarbage` is the same collection the flag would expose.
 */
export class RendererHeapProbe {
  readonly #consoleApplication: ConsoleApplication;
  readonly #cdpSession: CDPSession;

  private constructor(consoleApplication: ConsoleApplication, cdpSession: CDPSession) {
    this.#consoleApplication = consoleApplication;
    this.#cdpSession = cdpSession;
  }

  public static async attachTo(consoleApplication: ConsoleApplication): Promise<RendererHeapProbe> {
    const cdpSession = await consoleApplication.application
      .context()
      .newCDPSession(consoleApplication.window);
    return new RendererHeapProbe(consoleApplication, cdpSession);
  }

  /**
   * Collect, let finalisation run, and read the settled heap.
   *
   * The loop is this process's own — it collects over a DevTools session rather than
   * through a resolved collector — but the ROUND COUNT is `heap-sampling.ts`'s, which
   * is the console's declared home for the settling discipline. A local copy of the
   * number would go on collecting four times after that one was raised, and the row
   * would read a floor the in-process tier no longer reaches with nothing failing.
   */
  public async readSettledBytes(): Promise<number> {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      await this.#cdpSession.send("HeapProfiler.collectGarbage");
      await this.#consoleApplication.window.evaluate(
        async () =>
          new Promise((resolve) => {
            setTimeout(resolve, 0);
          }),
      );
    }
    return readSettledHeapBytes(this.#consoleApplication);
  }

  public async detach(): Promise<void> {
    await this.#cdpSession.detach();
  }
}
