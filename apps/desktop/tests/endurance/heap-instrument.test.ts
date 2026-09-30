// The tier's heap reading, held to the property every figure rests on: it reports what is
// still reachable, not what has merely not been collected yet.
//
// Every gated figure is arithmetic on two readings taken seconds apart, a few round trips after
// `expectPreciseHeapInstrument` allocates four megabytes and drops them. Whether that garbage
// lands in a baseline depends on whether V8 ran a major collection in between, so
// `RendererHeapProbe` collects over a DevTools session before it samples.
//
// The release arm is the assertion that matters: a reading that rises when bytes are planted
// proves only that the instrument moves, and a sampler that collects nothing passes that too.
// Only a reading that falls when the same bytes become unreachable fails without a collection.

import { describe, expect, it } from "vitest";

import {
  withLaunchedApp,
  type AppUnderTest,
  type LaunchAppOptions,
} from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { ENDURANCE_LAUNCH_OPTIONS } from "./endurance-workload.js";
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
 * This tier's launch with the precise-heap switch taken off.
 *
 * Spread from the tier's own options so the coarse launch differs in exactly one respect and
 * the refusal below cannot be explained by a second difference.
 */
const COARSE_LAUNCH_OPTIONS: LaunchAppOptions = {
  ...ENDURANCE_LAUNCH_OPTIONS,
  isPreciseHeapReadingRequired: false,
};

/**
 * Where the planted allocation is held while the case reads around it.
 *
 * A global, because the plant and the release are separate round trips into the renderer and
 * the driver process cannot hold a renderer reference across them. The name is distinct from
 * the build's fixture globals so a collision cannot make one case's scaffolding another's subject.
 */
const PLANTED_ALLOCATION_GLOBAL = "__consoleHeapInstrumentPlantedAllocation";

/**
 * How much of the planted figure a reading must move to count as having measured it.
 *
 * Half, and deliberately looser than the precision probe's own window: that one is a claim
 * about the instrument, drawn tight around a known size; this one only asks whether the
 * reader saw the plant and gave it back, across a whole console. Tightening it would let the
 * console's own allocation between two readings decide the verdict.
 */
const MINIMUM_MEASURED_PLANT_BYTES = PRECISION_PROBE_NOMINAL_BYTES / 2;

/**
 * Allocates the plant, holds it reachable from the renderer's global object, and answers the
 * character the indexing read saw.
 *
 * Shape and size come from the probe's exported constants, so the plant cannot drift from what
 * it stands in for; they are arguments because a function handed to `page.evaluate` is
 * serialized by source and captures no closure. The indexing read flattens the string (a
 * repeat answers a rope) and, being consumed, cannot be elided; it is not the evidence of
 * flatness, the arms below are.
 */
function plantRetainedHeapBytes(consoleApplication: AppUnderTest): Promise<number> {
  return consoleApplication.window.evaluate(
    ([globalName, characterCount, fillCharacter]: [string, number, string]) => {
      // The precision probe's own shape: one flat one-byte string.
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
function releaseRetainedHeapBytes(consoleApplication: AppUnderTest): Promise<void> {
  return consoleApplication.window.evaluate((globalName: string) => {
    delete (globalThis as unknown as Record<string, unknown>)[globalName];
  }, PLANTED_ALLOCATION_GLOBAL);
}

describe.skipIf(!bundleIsBuilt)("endurance — the reading every gated figure is taken with", () => {
  it("measures bytes planted after the precision precondition, and gives them back", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
      try {
        // The precondition first, where the tier's own cases put it and as they leave it:
        // four megabytes allocated, proved and dropped.
        await expectPreciseHeapInstrument(consoleApplication, heapProbe);

        const baselineBytes = await heapProbe.readSettledBytes();
        expect(
          await plantRetainedHeapBytes(consoleApplication),
          "the plant is not the character the probe's own allocation is made of, so the two are no longer the same shape and this case is measuring something the tier does not use",
        ).toBe(PRECISION_PROBE_FILL_CHARACTER.charCodeAt(0));
        const plantedBytes = await heapProbe.readSettledBytes();
        await releaseRetainedHeapBytes(consoleApplication);
        const releasedBytes = await heapProbe.readSettledBytes();

        // A baseline still carrying the precondition's four megabytes would shrink by about
        // the plant's weight, and the growth this tier gates would come out at nothing.
        expect(
          plantedBytes - baselineBytes,
          `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B retained allocation moved the reading by ` +
            `${String(plantedBytes - baselineBytes)} B, so the baseline it was added to was ` +
            "carrying uncollected garbage rather than this renderer's reachable heap",
        ).toBeGreaterThanOrEqual(MINIMUM_MEASURED_PLANT_BYTES);

        // The arm a sampler cannot pass: the same bytes, now unreachable, are gone from the
        // reading. True only of a reading taken after a collection.
        expect(
          plantedBytes - releasedBytes,
          `the reading fell by ${String(plantedBytes - releasedBytes)} B when the only reference ` +
            "to the plant was dropped, so it is reporting allocated-and-uncollected bytes rather " +
            "than reachable ones — no difference taken with it is a measurement of retention",
        ).toBeGreaterThanOrEqual(MINIMUM_MEASURED_PLANT_BYTES);
      } finally {
        // Detached before the window closes: detaching a DevTools session from a closed
        // application raises over whatever the body was failing on.
        await heapProbe.detach();
      }
    });
  });

  it("refuses the reading a launch without the precise instrument serves", async () => {
    // Negative control for the precondition itself. Every other case passes it, which shows it
    // accepts a precise instrument and nothing about whether it would accept a coarse one. So
    // the same probe runs against the console launched without the switch and must refuse.
    //
    // A whole second Electron is the cheap option: arithmetic over readings pasted into a
    // comment proves the arithmetic, not the instrument. Measured on macOS / Electron 44, the
    // coarse launch answers both reads of every window from one cached value, each difference
    // is exactly 0 B, and the floor trips, so the message names the instrument.
    //
    // The floor is the first check that can trip, because the probe's three content checks
    // (instrument present, payload length, last character) ignore precision and pass first. If
    // one ever fired first this case would fail on a message it does not match.
    await withLaunchedApp(COARSE_LAUNCH_OPTIONS, async (consoleApplication) => {
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
// Not skipped on the fixture bundle: none of it launches anything. A live renderer cannot be
// made to produce a window a major collection landed inside, or the ubuntu runner's second
// backing store, and those are the readings the band was shaped for.
describe("endurance — the precision window's own arithmetic", () => {
  // Every figure is a reading this tier has taken. Collected windows on macOS / Electron 44
  // read 4,000,560 B; uncollected windows read 3,993,316 B and -40,452,864 B; a second backing
  // store on the ubuntu runner read 8,022,500 B; the coarse launch reads 0 B.
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
    // The floor sits below the payload for this case. Three such windows are the worst case:
    // the median cannot discard what every window says, so the band itself must admit it.
    expect(
      precisionProbeRefusalFor([
        UNCOLLECTED_WINDOW_BYTES,
        UNCOLLECTED_WINDOW_BYTES,
        UNCOLLECTED_WINDOW_BYTES,
      ]),
    ).toBeNull();
  });

  it("discards one contaminated window at either end", () => {
    // Contamination runs both ways, hence the median: a major collection inside one window
    // drives it far negative, a second live allocation far high. Either survives while the
    // other two windows agree.
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
    // Both causes, because the arithmetic cannot tell them apart.
    expect(refusal).toMatch(/less than the allocation weighs/);
    expect(refusal).toMatch(/--enable-precise-memory-info/);
    expect(refusal).toMatch(/unflattened/);
  });

  it("refuses a reading carrying more than the probe's own allocation", () => {
    // Two windows agreeing on a contaminated figure are not an outlier; the ceiling turns "the
    // reading moved" into "the reading measured this".
    expect(
      precisionProbeRefusalFor([
        SECOND_BACKING_STORE_BYTES,
        SECOND_BACKING_STORE_BYTES,
        PRECISE_WINDOW_BYTES,
      ]),
    ).toMatch(/more than the allocation weighs/);
  });

  it("reports the windows it judged, in the order they were taken", () => {
    // A median alone hides which window was the odd one; the refusal lists all of them.
    const refusal = precisionProbeRefusalFor([
      COARSE_INSTRUMENT_BYTES,
      COARSE_INSTRUMENT_BYTES,
      PRECISE_WINDOW_BYTES,
    ]);
    expect(refusal).toContain(`windows: 0, 0, ${String(PRECISE_WINDOW_BYTES)}`);
  });

  it("takes the middle of an odd count and the mean of the two middle of an even one", () => {
    // The two callers both pass three, so nothing else would notice the even arm changing.
    expect(medianOfHeapReadings([3, 1, 2])).toBe(2);
    expect(medianOfHeapReadings([4, 1, 3, 2])).toBe(2.5);
    expect(medianOfHeapReadings([7])).toBe(7);
  });
});
