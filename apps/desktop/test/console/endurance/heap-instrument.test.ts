// The tier's heap reading, held to the one property every figure it serves rests on:
// it reports what is still REACHABLE, not what has merely not been collected yet.
//
// Every gated figure in this tier is arithmetic on two readings taken seconds apart,
// and each of them is taken a few round trips after `expectPreciseHeapInstrument`,
// which proves the instrument by allocating four megabytes and then dropping them.
// That is half the steady-state growth ceiling standing unreachable in front of a
// baseline. Whether it lands in that baseline is not a question the caller can answer
// by inspection — it depends on whether V8 happened to run a major collection between
// two evaluates — so the reading itself has to settle it, and `RendererHeapProbe`
// does, by collecting over a DevTools session before it samples.
//
// WHY THE RELEASE ARM IS THE ASSERTION THAT MATTERS. A reading that rises when bytes
// are planted proves only that the instrument moves; a sampler that collects nothing
// passes that just as well. What separates the two is whether the reading FALLS when
// the same bytes become unreachable, which is a claim no sampler can make and a
// forced collection makes by construction — so the two arms are asserted together,
// and the second is the one that fails on a reading taken without the collection.

import { describe, expect, it } from "vitest";

import {
  withLaunchedConsole,
  type ConsoleApplication,
  type LaunchConsoleOptions,
} from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { ENDURANCE_LAUNCH_OPTIONS } from "./console-workload.js";
import {
  expectPreciseHeapInstrument,
  medianOfHeapReadings,
  PRECISION_PROBE_FILL_CHARACTER,
  PRECISION_PROBE_NOMINAL_BYTES,
  precisionProbeRefusalFor,
  RendererHeapProbe,
} from "./heap-instrument.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * This tier's launch with the one switch the precondition is about taken off it.
 *
 * Spread from the tier's own options rather than composed fresh, so the coarse
 * launch differs from every other launch in this tier in exactly one respect and the
 * refusal below cannot be explained by a second difference. It is a whole second
 * Electron, which is what makes it a control rather than a recital: the alternative
 * was to assert this function's arithmetic over readings recorded in a comment, and a
 * comment cannot go stale in a way anything fails on.
 */
const COARSE_LAUNCH_OPTIONS: LaunchConsoleOptions = {
  ...ENDURANCE_LAUNCH_OPTIONS,
  isPreciseHeapReadingRequired: false,
};

/**
 * Where the planted allocation is held while the case reads around it.
 *
 * A global rather than a closure, because the plant and the release are two separate
 * round trips into the renderer and nothing in the driver process can hold a
 * reference to a renderer object across them. Named distinctly from the build's own
 * fixture handles (`fixture-handles.ts`) so a collision cannot make one case's
 * scaffolding another case's subject.
 */
const PLANTED_ALLOCATION_GLOBAL = "__sidekicksHeapInstrumentPlantedAllocation";

/**
 * How much of the planted figure a reading must move to count as having measured it.
 *
 * Half, and DELIBERATELY looser than the precision probe's own window, because the
 * two assertions are about different things. That one is a claim about the
 * instrument and is drawn tight around a size known at its call site; this one is a
 * claim about the READER around it — three settled readings taken a forced
 * collection apart, with a whole console between them — and asks only whether the
 * plant was seen at all and given back. A threshold this far above noise cannot be
 * met by anything but the plant, and tightening it would make the console's own
 * allocation between two readings decide a verdict that is not about the console.
 */
const MINIMUM_MEASURED_PLANT_BYTES = PRECISION_PROBE_NOMINAL_BYTES / 2;

/**
 * Allocate the plant, hold it reachable from the renderer's global object, and
 * answer the character the indexing read saw.
 *
 * THE SHAPE AND THE SIZE ARE BOTH THE PROBE'S, taken from its own exported constants
 * rather than spelled here, because a plant that stopped matching the shape it stands
 * in for would go on passing while measuring something else. They arrive as arguments
 * because a function handed to `page.evaluate` is serialized by its source and
 * captures no closure.
 *
 * The character code comes back because the read that produces it is what gets the
 * value flattened: a repeat answers a rope of concatenation cells weighing a few
 * hundred bytes, and V8's character accessor flattens its receiver before indexing
 * it. That is today's runtime behaviour and not a guarantee, so the returned code is
 * NOT the evidence of flatness — the arms below are, since a rope moves the reading
 * by three orders of magnitude too little to satisfy either. What returning it buys
 * is smaller and still necessary: an indexing read nothing consumes is elidable, and
 * an elided read flattens nothing.
 */
function plantRetainedHeapBytes(consoleApplication: ConsoleApplication): Promise<number> {
  return consoleApplication.window.evaluate(
    ([globalName, characterCount, fillCharacter]: [string, number, string]) => {
      // The precision probe's own shape: one flat one-byte string, a byte a character.
      const retained = fillCharacter.repeat(characterCount);
      (globalThis as unknown as Record<string, unknown>)[globalName] = retained;
      return retained.charCodeAt(characterCount - 1);
    },
    [PLANTED_ALLOCATION_GLOBAL, PRECISION_PROBE_NOMINAL_BYTES, PRECISION_PROBE_FILL_CHARACTER] as [
      string,
      number,
      string,
    ],
  );
}

/** Drop the only reference to the plant, leaving it unreachable and uncollected. */
function releaseRetainedHeapBytes(consoleApplication: ConsoleApplication): Promise<void> {
  return consoleApplication.window.evaluate((globalName: string) => {
    delete (globalThis as unknown as Record<string, unknown>)[globalName];
  }, PLANTED_ALLOCATION_GLOBAL);
}

describe.skipIf(!bundleIsBuilt)("endurance — the reading every gated figure is taken with", () => {
  it("measures bytes planted after the precision precondition, and gives them back", async () => {
    await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
      try {
        // The precondition first, exactly where the tier's own cases put it — and
        // exactly as they leave it: four megabytes allocated, proved, and dropped.
        await expectPreciseHeapInstrument(consoleApplication, heapProbe);

        const baselineBytes = await heapProbe.readSettledBytes();
        expect(
          await plantRetainedHeapBytes(consoleApplication),
          "the plant is not the character the probe's own allocation is made of, so the two are no longer the same shape and this case is measuring something the tier does not use",
        ).toBe(PRECISION_PROBE_FILL_CHARACTER.charCodeAt(0));
        const plantedBytes = await heapProbe.readSettledBytes();
        await releaseRetainedHeapBytes(consoleApplication);
        const releasedBytes = await heapProbe.readSettledBytes();

        // Measured, not masked. A baseline still carrying the precondition's own
        // four megabytes has that much to give back, so the plant lands on top of a
        // figure that is about to shrink by roughly what the plant weighs — and the
        // growth this tier gates comes out at nothing.
        expect(
          plantedBytes - baselineBytes,
          `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B retained allocation moved the reading by ` +
            `${String(plantedBytes - baselineBytes)} B, so the baseline it was added to was ` +
            "carrying uncollected garbage rather than this renderer's reachable heap",
        ).toBeGreaterThanOrEqual(MINIMUM_MEASURED_PLANT_BYTES);

        // And the arm a sampler cannot pass: the same bytes, now unreachable, are
        // gone from the reading. This is the property the whole tier's arithmetic
        // rests on, and it is true only of a reading taken after a collection.
        expect(
          plantedBytes - releasedBytes,
          `the reading fell by ${String(plantedBytes - releasedBytes)} B when the only reference ` +
            "to the plant was dropped, so it is reporting allocated-and-uncollected bytes rather " +
            "than reachable ones — no difference taken with it is a measurement of retention",
        ).toBeGreaterThanOrEqual(MINIMUM_MEASURED_PLANT_BYTES);
      } finally {
        // Detached before the wrapper closes the window: detaching a DevTools session
        // from a closed application raises over whatever the body was failing on.
        await heapProbe.detach();
      }
    });
  });

  it("refuses the reading a launch without the precise instrument serves", async () => {
    // THE NEGATIVE CONTROL FOR THE PRECONDITION ITSELF. Every other case in this tier
    // calls `expectPreciseHeapInstrument` and passes, which establishes that it
    // ACCEPTS a precise instrument and nothing at all about whether it would accept a
    // coarse one — and a precondition that accepts both is a line of code, not a gate.
    // So the same probe is run against the same console launched without the switch,
    // and the assertion is that it REFUSES.
    //
    // A whole second Electron for one assertion, and it is the cheap option against
    // what it replaces: arithmetic over readings pasted into a comment proves the
    // arithmetic and not the instrument, and goes on passing after Blink changes what
    // the default form reports. Measured on macOS / Electron 44, the coarse launch
    // answers both reads of every window from one cached value and each difference is
    // exactly 0 B, so the FLOOR is what trips and the message names the instrument
    // rather than the number.
    //
    // AND THE FLOOR IS THE FIRST THING THAT CAN TRIP, which is a property of the order
    // the probe asserts in rather than of the matcher here. Three content checks run
    // inside its loop ahead of the band — the instrument's presence, the payload's
    // length, and its last character — and none of them is sensitive to precision, so
    // in coarse mode all three pass and the band is reached. If one ever did fire
    // first this case fails loudly on a message it does not match rather than passing
    // for the wrong reason, which is the safe direction for a control to be wrong in.
    await withLaunchedConsole(COARSE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
      try {
        await expect(
          expectPreciseHeapInstrument(consoleApplication, heapProbe),
          "the precondition accepted a launch that never asked for the precise instrument, so it is asserting nothing on the launches that do",
        ).rejects.toThrow(/less than the allocation weighs/);
      } finally {
        await heapProbe.detach();
      }
    });
  });
});

// The band and the statistic, driven over readings a launch cannot be asked for.
//
// NOT SKIPPED ON THE FIXTURE BUNDLE, because none of it launches anything: the verdict
// is arithmetic over numbers, and pulling it out of the probe is what makes the
// contaminated cases reachable at all. A live renderer can be made to produce a precise
// reading and a coarse one — the two cases above do exactly that — and cannot be made
// to produce a window a major collection landed inside, or the ubuntu runner's second
// backing store. Those are the readings the shape was changed for, so they are the ones
// that have to be run rather than recorded.
describe("endurance — the precision window's own arithmetic", () => {
  // Every figure below is a reading this tier has actually taken, not a number chosen
  // to sit where a case needs it. The collected windows on macOS / Electron 44 read
  // 4,000,560 B; one uncollected window read 3,993,316 B and another −40,452,864 B;
  // the shape this replaced read 8,022,500 B on the ubuntu runner, which is the
  // failure the branch exists to fix; and the coarse launch reads 0 B.
  const PRECISE_WINDOW_BYTES = 4_000_560;
  const UNCOLLECTED_WINDOW_BYTES = 3_993_316;
  const MAJOR_COLLECTION_WINDOW_BYTES = -40_452_864;
  const SECOND_BACKING_STORE_BYTES = 8_022_500;
  const COARSE_INSTRUMENT_BYTES = 0;

  it("accepts the reading a collected window actually produces", () => {
    expect(
      precisionProbeRefusalFor([PRECISE_WINDOW_BYTES, PRECISE_WINDOW_BYTES, PRECISE_WINDOW_BYTES]),
    ).toBeNull();
  });

  it("accepts a window the collector netted bytes out of, which sits under the payload", () => {
    // The floor's whole reason for being below the payload rather than at it. Three
    // such windows are the worst case: the median cannot discard what every window
    // says, so this is the reading the band itself has to admit.
    expect(
      precisionProbeRefusalFor([
        UNCOLLECTED_WINDOW_BYTES,
        UNCOLLECTED_WINDOW_BYTES,
        UNCOLLECTED_WINDOW_BYTES,
      ]),
    ).toBeNull();
  });

  it("discards one contaminated window at either end", () => {
    // Contamination runs both ways, which is why the statistic is a median: a major
    // collection inside one window drives it far negative, and a second live
    // allocation inside one drives it far high. Either survives as long as the other
    // two windows agree.
    expect(
      precisionProbeRefusalFor([
        MAJOR_COLLECTION_WINDOW_BYTES,
        PRECISE_WINDOW_BYTES,
        PRECISE_WINDOW_BYTES,
      ]),
    ).toBeNull();
    expect(
      precisionProbeRefusalFor([
        PRECISE_WINDOW_BYTES,
        PRECISE_WINDOW_BYTES,
        SECOND_BACKING_STORE_BYTES,
      ]),
    ).toBeNull();
  });

  it("refuses the coarse instrument's motionless reading, naming both causes", () => {
    const refusal = precisionProbeRefusalFor([
      COARSE_INSTRUMENT_BYTES,
      COARSE_INSTRUMENT_BYTES,
      COARSE_INSTRUMENT_BYTES,
    ]);
    // Both, because the arithmetic cannot tell them apart and a message naming one
    // would send a reader after the wrong fault half the time it fires.
    expect(refusal).toMatch(/less than the allocation weighs/);
    expect(refusal).toMatch(/--enable-precise-memory-info/);
    expect(refusal).toMatch(/unflattened/);
  });

  it("refuses a reading carrying more than the probe's own allocation", () => {
    // The ubuntu failure, as the median sees it: two windows agreeing on the
    // contaminated figure is not an outlier to discard, and the ceiling is what makes
    // "the reading moved" into "the reading measured this".
    expect(
      precisionProbeRefusalFor([
        SECOND_BACKING_STORE_BYTES,
        SECOND_BACKING_STORE_BYTES,
        PRECISE_WINDOW_BYTES,
      ]),
    ).toMatch(/more than the allocation weighs/);
  });

  it("reports the windows it judged, in the order they were taken", () => {
    // The refusal is what an operator reads on a failing endurance run, and a median
    // alone hides which window was the odd one. Both are in the sentence.
    const refusal = precisionProbeRefusalFor([
      COARSE_INSTRUMENT_BYTES,
      COARSE_INSTRUMENT_BYTES,
      PRECISE_WINDOW_BYTES,
    ]);
    expect(refusal).toContain(`windows: 0, 0, ${String(PRECISE_WINDOW_BYTES)}`);
  });

  it("takes the middle of an odd count and the mean of the two middle of an even one", () => {
    // The sweep's rule, carried over verbatim when the median was hoisted out of
    // `terminal-instance-series.ts`. Asserted here because the two callers both pass
    // three today, so nothing else in the tier would notice the even arm changing.
    expect(medianOfHeapReadings([3, 1, 2])).toBe(2);
    expect(medianOfHeapReadings([4, 1, 3, 2])).toBe(2.5);
    expect(medianOfHeapReadings([7])).toBe(7);
  });
});
