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
 * What the precision probe weighs, and the length of the string that weighs it.
 *
 * ONE NUMBER FOR BOTH, and that is the reason the shape is a flat one-byte string
 * rather than an array of anything: a byte a character makes the payload's size and
 * its length the same figure, so this module owns no per-element width it would then
 * have to keep true in two places. The probe repeats a single character this many
 * times and the read that flattens the value allocates one sequential one-byte
 * string of exactly this length — a single heap object whose size is known at the
 * call site, and one that depends on no elements kind, so nothing about it can
 * transition.
 *
 * WHY NOT THE DOUBLE ARRAY THIS USED TO BE. `new Array(500_000)` is far above V8's
 * fast-elements preallocation limit, so it is created in dictionary mode and the
 * sequential double stores drive it through a representation change: what ends up
 * retained is a four-megabyte double-elements backing store, and the store it
 * replaced is the same size again, unreachable and COUNTED until a collection runs.
 * Measured on this build across fourteen windows the shape read 4,000,040 B where a
 * collection had already run and −38,965,632 B where one landed inside the window;
 * on the ubuntu runner it read 8,022,500 B, past the old ceiling of 8,000,000 —
 * both backing stores counted at once. The window was asserting V8's elements
 * representation and the collector's timing, which are the two things this
 * precondition is not about.
 *
 * Exported because the control that proves the collection happened plants an
 * allocation of the same shape and the same size, and a second figure written into
 * that file would be a second answer to how big "big enough to see" is.
 */
export const PRECISION_PROBE_NOMINAL_BYTES: number = 4_000_000;

/**
 * The character the probe's string is made of.
 *
 * Named because it crosses into the renderer as an argument and comes back as a
 * character code the assertion checks: the flattening read has to be OBSERVED to
 * have read the payload, and a code compared against a literal spelled twice is a
 * comparison of this file with itself.
 */
const PRECISION_PROBE_FILL_CHARACTER = "x";

/**
 * What V8 spends AROUND the payload, and the only slack the window below carries.
 *
 * The retained value is the payload plus a sequential-string header, and the
 * doubling the repeat performs leaves a handful of concatenation cells the
 * flattening read degenerates rather than frees. Measured across fourteen collected
 * windows on this build the whole of that overhead was 560 B — the same figure
 * every time — so this allowance is not a tolerance the reading needs. It is room
 * for a platform whose header width or large-object alignment differs from this
 * one's, and it is stated rather than absorbed so a reader can see how much of the
 * window is measurement and how much is margin.
 *
 * Sixty-four kibibytes: two orders of magnitude above the measured overhead, and
 * far below what it has to keep out. The shape this probe replaced overshot by a
 * whole second backing store — four megabytes — and the default instrument moves by
 * nothing at all.
 */
const PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES = 65_536;

/**
 * The window the probe's own growth has to land in.
 *
 * FLOOR: the payload itself. Four million one-byte characters weigh four million
 * bytes on the heap and cannot weigh less, so this end is arithmetic rather than a
 * tolerance — and it is the end that rules out the default instrument, which is
 * quantized and served from a long-interval cache and recites one value for both
 * reads. Measured with the flag dropped from this tier's launch: growth of exactly
 * 0 B across twelve windows (macOS, Electron 44). That figure is not cited as
 * evidence here — `heap-instrument.test.ts` launches without the flag and asserts
 * this function REFUSES, so the claim is run rather than recorded.
 *
 * CEILING: the payload plus the overhead allowance. A floor alone passes any
 * instrument that moved by at least this much for any reason — a quantized one that
 * stepped its grid, or the replaced shape carrying a second backing store — so the
 * ceiling is what turns "the reading moved" into "the reading measured this".
 */
const PRECISION_PROBE_MIN_OBSERVED_BYTES = PRECISION_PROBE_NOMINAL_BYTES;

const PRECISION_PROBE_MAX_OBSERVED_BYTES =
  PRECISION_PROBE_NOMINAL_BYTES + PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES;

/**
 * How many windows the probe takes, and why the largest of them is the reading.
 *
 * A collection that lands BETWEEN the two reads can only lower their difference: it
 * reclaims bytes that were already there and adds none. So a window a collection
 * landed in is not a measurement of this allocation, and the largest of several
 * windows is the one least contaminated by one. Nothing about that weakens the
 * ceiling — it is applied to the largest, which is the strictest place to apply it —
 * and it cannot rescue the default instrument, whose every window is 0.
 *
 * Three, because each window is taken behind its own forced collection and that
 * makes a contaminated window rare rather than routine. Measured on this build:
 * fourteen COLLECTED windows read 4,000,560 B every time, where fourteen
 * uncollected windows on the same launch read 4,000,560 B ten times, 4,001,852 B
 * and 3,993,316 B — below the payload — once each, and −40,452,864 B once.
 */
const PRECISION_PROBE_WINDOW_COUNT = 3;

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
 * So the flag is not trusted. An allocation of a size known at this call site is
 * made between two reads and the growth has to land in a window drawn around that
 * size, which is a claim about the instrument rather than about the console — and it
 * is asserted by the cases that spend the instrument, not inside the reader, so it
 * costs a few round trips per tier case rather than one per sample.
 *
 * EACH WINDOW IS TAKEN BEHIND A FORCED COLLECTION, which is the correction rather
 * than a precaution. An uncollected window reports whatever the collector reclaimed
 * inside it beside what this allocation added, so its difference is the console's
 * garbage as much as the probe's — measured at −40,452,864 B on a window a major
 * collection landed in. That is why the reader this tier gates on is the argument
 * rather than a session opened here: the precondition is proved with the same
 * collector the readings it guards are taken behind.
 *
 * IT LEAVES ONE PAYLOAD BEHIND — four megabytes, unreachable and uncollected. One
 * and not one per window, because each window's collection reclaims the previous
 * window's string; only the last is still there when this returns. Every caller
 * therefore takes its next reading through {@link RendererHeapProbe}, which collects
 * before it reads; a sampler-only reading taken here would carry the proof into the
 * figure the proof exists to make trustworthy.
 */
export async function expectPreciseHeapInstrument(
  consoleApplication: ConsoleApplication,
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
        // The repeat builds by doubling and answers a rope of concatenation cells
        // weighing a few hundred bytes; THIS read is what flattens it into the one
        // sequential string the window is measuring. It is taken for that reason and
        // not as a check, and its result is returned so the flattening cannot be
        // elided as a read nothing consumes.
        const lastCharacterCode = retained.charCodeAt(characterCount - 1);
        const afterBytes = readHeapBytes();
        // Read AFTER the second sample so the string is still reachable across it — an
        // allocation V8 may collect before the reading it is the subject of proves nothing.
        return { beforeBytes, afterBytes, retainedLength: retained.length, lastCharacterCode };
      },
      [PRECISION_PROBE_NOMINAL_BYTES, PRECISION_PROBE_FILL_CHARACTER] as [number, string],
    );

    expect(probe.beforeBytes, HEAP_INSTRUMENT_UNAVAILABLE).not.toBeNull();
    expect(probe.retainedLength).toBe(PRECISION_PROBE_NOMINAL_BYTES);
    expect(probe.lastCharacterCode).toBe(PRECISION_PROBE_FILL_CHARACTER.charCodeAt(0));
    observedBytesPerWindow.push(Number(probe.afterBytes) - Number(probe.beforeBytes));
  }

  const observedBytes = Math.max(...observedBytesPerWindow);
  const observedWindows = observedBytesPerWindow.map((bytes) => String(bytes)).join(", ");
  expect(
    observedBytes,
    `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B allocation moved the renderer's heap reading by ` +
      `${String(observedBytes)} B at most (${observedWindows}), which is less than the allocation ` +
      "weighs — this launch is reading Blink's default quantized, cached MemoryInfo rather than " +
      "the precise one",
  ).toBeGreaterThanOrEqual(PRECISION_PROBE_MIN_OBSERVED_BYTES);
  expect(
    observedBytes,
    `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B allocation moved the renderer's heap reading by ` +
      `${String(observedBytes)} B at most (${observedWindows}), which is more than the allocation ` +
      "weighs — the reading is carrying something other than this probe's own string, so a " +
      "difference taken with it is not a measurement of what was allocated between two reads",
  ).toBeLessThanOrEqual(PRECISION_PROBE_MAX_OBSERVED_BYTES);
}

/**
 * Read the renderer's heap as the minimum over settling samples.
 *
 * MODULE-PRIVATE, and that is the fix rather than a tidying: a sampler forces no
 * collection, so what it answers depends on whether V8 happened to run one — and
 * every reading this tier gates on is taken a few round trips after a precondition
 * that leaves four megabytes of unreachable string behind. Exported, it was reached
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
   * Collect, and let pending finalisation run.
   *
   * The loop is this process's own — it collects over a DevTools session rather than
   * through a resolved collector — but the ROUND COUNT is `heap-sampling.ts`'s, which
   * is the console's declared home for the settling discipline. A local copy of the
   * number would go on collecting four times after that one was raised, and the row
   * would read a floor the in-process tier no longer reaches with nothing failing.
   *
   * PUBLIC because the tier's PRECONDITION needs exactly this collection and must not
   * have a second one: {@link expectPreciseHeapInstrument} measures a difference of
   * two heap readings taken either side of one allocation, and over an uncollected
   * heap that difference reports whatever the collector reclaimed inside the window
   * as well. Handing it this method rather than a session of its own is what makes
   * the precondition and the readings it guards the same instrument.
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

  /** Collect, let finalisation run, and read the settled heap. */
  public async readSettledBytes(): Promise<number> {
    await this.collectGarbage();
    return readSettledHeapBytes(this.#consoleApplication);
  }

  public async detach(): Promise<void> {
    await this.#cdpSession.detach();
  }
}
