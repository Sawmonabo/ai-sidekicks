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
 * EXPORTED for the same reason the size beside it is: the control that proves the
 * collection happened plants an allocation of the same shape, and a shape is a size
 * AND a character. Left private, the size half was single-sourced and the shape half
 * was two bare literals in two files — so a move to a two-byte character would halve
 * the bytes-per-character identity this whole design rests on and the control would
 * go on planting the old one with nothing failing.
 *
 * Both call sites take it as an ARGUMENT rather than reading it from module scope,
 * because a function handed to `page.evaluate` is serialized by its source and
 * captures no closure: an identifier from this module would be undefined inside the
 * renderer. That is also why the two construction bodies are spelled twice rather
 * than shared — the values are single-sourced and the three lines around them cannot
 * be.
 */
export const PRECISION_PROBE_FILL_CHARACTER: string = "x";

/**
 * How far either end of the window sits from the payload, and the only slack it
 * carries.
 *
 * It answers a different question at each end, which is why one figure serves both.
 * ABOVE the payload it is what V8 spends around it: a sequential-string header, plus
 * the handful of concatenation cells the doubling leaves and the flattening read
 * degenerates rather than frees. Measured across fourteen collected windows the whole
 * of that overhead was 560 B, the same figure every time, and 1,852 B on the first
 * window of a session, where the evaluate's own first-call allocations are still
 * counted — so upward this is not a tolerance the reading needs, it is room for a
 * platform whose header width or large-object alignment differs from the one measured
 * here (macOS, Electron 44).
 * BELOW it, the difference of two readings can fall under the payload when the
 * collector nets bytes out inside the window, which the forced collection makes rare
 * rather than impossible; the widest such excursion measured here was 6,684 B, and
 * this is ten times it.
 *
 * Sixty-four kibibytes: two orders of magnitude above the measured overhead in one
 * direction and an order above the measured excursion in the other, and far inside
 * what it has to keep out at both ends. The shape this probe replaced overshot by a
 * whole second backing store — four megabytes — an unflattened payload undershoots by
 * very nearly the whole of it, and the default instrument does not move at all.
 *
 * Stated rather than absorbed, so a reader can see how much of the window is
 * measurement and how much is margin.
 */
const PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES = 65_536;

/**
 * The window the probe's own growth has to land in — the payload, plus or minus the
 * allowance at either end.
 *
 * SYMMETRIC, and the lower end is where that matters. The payload cannot weigh less
 * than four million bytes, but the quantity asserted is not the payload: it is a
 * DIFFERENCE of two heap readings, and a difference sits below the payload whenever
 * the collector nets bytes out inside the window. This file records its own
 * counterexample a few lines down — an uncollected window that read 3,993,316 B,
 * 6,684 B under the payload. A floor at the payload itself would have had 560 B of
 * headroom against that, so it would have been a second version of the ceiling
 * failure this shape was chosen to fix, moved to the other end.
 *
 * WHAT THE FLOOR STILL RULES OUT, at 3,934,464 B. The default instrument read 0 B in
 * every one of twelve windows with the flag dropped from this tier's launch (macOS,
 * Electron 44), so any floor above zero rejects it and this one stands 3,934,464 B
 * clear. Nor is that a knife edge if the cache in front of it ever lapses: the widest
 * the recited value moved BETWEEN those windows was 21,280 B, and this end is roughly
 * two hundred times that. An unflattened payload is ruled out just as widely — a rope
 * measures a few hundred bytes. None of it is cited as evidence here;
 * `heap-instrument.test.ts` launches without the flag and asserts this function
 * REFUSES, so the claim is run rather than recorded.
 *
 * CEILING: the payload plus the same allowance. A floor alone passes any instrument
 * that moved by at least this much for any reason, so the ceiling is what turns "the
 * reading moved" into "the reading measured this" — and it is what the replaced
 * shape failed, carrying a second backing store. It is NOT claimed to rule out a
 * quantized instrument that stepped its grid at every heap size: a coarse step is a
 * fraction of the heap it steps on, so at a large enough renderer one step could
 * land inside this band. What makes the coarse launch fail here is the cache in
 * front of the reading, which serves one value to both reads.
 */
const PRECISION_PROBE_MIN_OBSERVED_BYTES =
  PRECISION_PROBE_NOMINAL_BYTES - PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES;

const PRECISION_PROBE_MAX_OBSERVED_BYTES =
  PRECISION_PROBE_NOMINAL_BYTES + PRECISION_PROBE_OVERHEAD_ALLOWANCE_BYTES;

/**
 * How many windows the probe takes, and why the middle one is the reading.
 *
 * THREE, TAKEN AS A MEDIAN, which is `HEAP_READING_SAMPLE_COUNT`'s count and
 * `HEAP_READING_SAMPLE_COUNT`'s statistic — the same question asked by
 * `terminal-instance-series.ts` about the same kind of quantity, and answered there
 * for the same reason: what a repeat has to reject is one outlying read, and
 * contamination runs BOTH ways. A collection landing between the two reads lowers
 * the difference; anything allocating into the window raises it. The largest of the
 * three would be robust against the first and defenceless against the second — and
 * the second is the direction the failure this shape replaced came from — 8,022,500 B
 * against an 8,000,000 B ceiling, a second backing store still counted. A
 * median discards one outlier at either end, and this module takes it through
 * {@link medianOfHeapReadings} rather than a second definition of the word.
 *
 * Three is also what a forced collection per window buys, and the measurements that
 * settled the count were taken as a sweep of fourteen consecutive windows on one
 * launch. Collected, all fourteen read 4,000,560 B — the same figure every time.
 * UNCOLLECTED on the same launch they read 4,000,560 B nine times, 4,001,852 B /
 * 4,000,592 B / 4,000,580 B once each, 3,993,316 B — below the payload — once, and
 * −40,452,864 B once. So a contaminated window is the exception, and three is the
 * smallest count whose median survives one.
 *
 * WHAT THE PROBE ITSELF READS is the head of that sweep rather than its body, and it
 * carries one systematic difference: across four launches the three windows read
 * 4,001,852 B, 4,000,560 B, 4,000,560 B, the same three figures in the same order
 * every time. The extra 1,292 B is what the FIRST evaluate of a session allocates for
 * itself and keeps. Far inside the allowance either way, so nothing here depended on
 * noticing it — recorded because it is what a maximum would have reported on every
 * run, where a median reports the figure two independent windows agree on.
 */
const PRECISION_PROBE_WINDOW_COUNT = 3;

/**
 * The median of a small set of heap readings.
 *
 * ONE IMPLEMENTATION, because this tier now asks the question twice — the precision
 * precondition over its windows, and `terminal-instance-series.ts` over the reads
 * behind each point of its sweep — and two private copies of a median are two
 * definitions of the word that can drift apart without either failing. It lives here
 * rather than beside either caller because the sweep already imports this module for
 * {@link RendererHeapProbe}, so this direction is the one that closes no cycle.
 *
 * Averaging the two middle values on an even count rather than taking a rank, which
 * is the sweep's own rule carried over verbatim: both current callers pass three, so
 * the arms agree today, and a hoist that quietly changed the even case would move a
 * printed figure with nothing saying so. `frame-time.test.ts` keeps its own median
 * deliberately — it is defined there in terms of that file's nearest-rank percentile,
 * over frame durations rather than heap bytes, and folding the two would change the
 * statistic that file reports.
 */
export function medianOfHeapReadings(readings: readonly number[]): number {
  const ordered = [...readings].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[ordered.length % 2 === 0 ? middle - 1 : middle] ?? 0;
  const upper = ordered[middle] ?? 0;
  return (lower + upper) / 2;
}

/**
 * Whether a set of probe windows is a measurement of the probe's own allocation, and
 * the sentence to raise when it is not.
 *
 * SEPARATED FROM THE LAUNCH ON PURPOSE. Everything above this line is arithmetic over
 * numbers, and reaching it only through a real Electron meant the band, the statistic,
 * and the two refusals could be exercised in exactly one configuration — the passing
 * one. Pulled out, `heap-instrument.test.ts` drives the real function over the
 * readings this tier has actually observed, including the ones a live launch cannot
 * be made to produce on demand.
 *
 * `null` for a measurement rather than a boolean, so a caller asserting on it prints
 * the refusal itself when it fails instead of `false`.
 */
export function precisionProbeRefusalFor(observedBytesPerWindow: readonly number[]): string | null {
  const observedBytes = medianOfHeapReadings(observedBytesPerWindow);
  const observedWindowsText = observedBytesPerWindow.map((bytes) => String(bytes)).join(", ");
  const preamble =
    `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B allocation moved the renderer's heap reading ` +
    `by ${String(observedBytes)} B (windows: ${observedWindowsText}), which is `;
  if (observedBytes < PRECISION_PROBE_MIN_OBSERVED_BYTES) {
    // Two causes, and the message names both because the assertion cannot tell them
    // apart: the flattening this probe relies on is V8 doing what it does today, not
    // a guarantee, and a rope reaches this end from the same direction a lost launch
    // flag does.
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
 * is asserted by the cases that spend the instrument, not inside the reader, so the
 * cost is per tier case and not per sample.
 *
 * WHAT A CALL COSTS, stated because it is no longer a few round trips: three windows,
 * each a forced collection — `SETTLE_ROUNDS` collections and as many round trips —
 * and one evaluate, so twelve collections and fifteen round trips per call, at the
 * five call sites this tier has. It is affordable against a per-test allowance of
 * `ENDURANCE_BODY_ALLOWANCE_MS`, and the cases spend it once each at the top rather
 * than around every reading; the control in `heap-instrument.test.ts` adds one cold
 * Electron launch to a project that runs its files serially, whose whole body is one
 * call to this function.
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
        // The repeat builds by doubling and answers a ROPE of concatenation cells
        // weighing a few hundred bytes, not the four megabytes this window is drawn
        // around. This read is the ask that gets it flattened: V8's character
        // accessor flattens the receiver before indexing it, so today this call is
        // what turns the rope into one sequential one-byte string. That is a runtime
        // heuristic and not a language guarantee, which is why NOTHING HERE ASSERTS
        // FLATNESS — the window's own floor is the evidence. A rope that reached the
        // second read unflattened measured 548 B on this build and fails that floor
        // by three orders of magnitude, so the probe cannot pass while resting on an
        // engine that stopped flattening here. The result is returned for a smaller
        // reason: an indexing read nothing consumes is elidable, and an elided read
        // flattens nothing.
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

  // The band, the statistic and both refusals are {@link precisionProbeRefusalFor}'s,
  // so what runs here is the same function the non-launching cases drive over readings
  // a live renderer cannot be asked to produce.
  //
  // RAISED AS THE FAILURE'S OWN MESSAGE rather than asserted as a value: an expectation
  // on the string renders it as a compared VALUE, and vitest elides a value past its
  // print width — the refusal arrived at the reader as "expected 'a 4000000 B
  // allocation mov…' to be null", which names neither the reading nor the cause. The
  // sentence this function exists to produce has to survive to the operator whole.
  const refusal = precisionProbeRefusalFor(observedBytesPerWindow);
  if (refusal !== null) {
    expect.fail(refusal);
  }
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
