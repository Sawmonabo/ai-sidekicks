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

import { withLaunchedConsole, type ConsoleApplication } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { ENDURANCE_LAUNCH_OPTIONS } from "./console-workload.js";
import {
  expectPreciseHeapInstrument,
  PRECISION_PROBE_ELEMENT_COUNT,
  PRECISION_PROBE_NOMINAL_BYTES,
  RendererHeapProbe,
} from "./heap-instrument.js";

const bundleIsBuilt = fixtureBundleExists();

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
 * Half, and it is the same fraction and the same reason as the precision probe's own
 * lower bound: the collector runs between the two readings, so an exact match would
 * make ordinary V8 housekeeping decide the verdict, while a threshold this far above
 * noise cannot be met by anything but the plant.
 */
const MEASURED_FRACTION_OF_PLANT = PRECISION_PROBE_NOMINAL_BYTES / 2;

/** Allocate the plant and hold it reachable from the renderer's global object. */
function plantRetainedHeapBytes(consoleApplication: ConsoleApplication): Promise<void> {
  return consoleApplication.window.evaluate(
    ([globalName, elementCount]: [string, number]) => {
      // The precision probe's own shape: a packed-double backing store allocated once,
      // so what the reading moves by is the array and not a copying loop's garbage.
      const retained = new Array<number>(elementCount);
      for (let element = 0; element < elementCount; element += 1) {
        retained[element] = element + 0.5;
      }
      (globalThis as unknown as Record<string, unknown>)[globalName] = retained;
    },
    [PLANTED_ALLOCATION_GLOBAL, PRECISION_PROBE_ELEMENT_COUNT] as [string, number],
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
        await expectPreciseHeapInstrument(consoleApplication);

        const baselineBytes = await heapProbe.readSettledBytes();
        await plantRetainedHeapBytes(consoleApplication);
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
        ).toBeGreaterThanOrEqual(MEASURED_FRACTION_OF_PLANT);

        // And the arm a sampler cannot pass: the same bytes, now unreachable, are
        // gone from the reading. This is the property the whole tier's arithmetic
        // rests on, and it is true only of a reading taken after a collection.
        expect(
          plantedBytes - releasedBytes,
          `the reading fell by ${String(plantedBytes - releasedBytes)} B when the only reference ` +
            "to the plant was dropped, so it is reporting allocated-and-uncollected bytes rather " +
            "than reachable ones — no difference taken with it is a measurement of retention",
        ).toBeGreaterThanOrEqual(MEASURED_FRACTION_OF_PLANT);
      } finally {
        // Detached before the wrapper closes the window: detaching a DevTools session
        // from a closed application raises over whatever the body was failing on.
        await heapProbe.detach();
      }
    });
  });
});
