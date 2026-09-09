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
  PRECISION_PROBE_NOMINAL_BYTES,
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
const MEASURED_FRACTION_OF_PLANT = PRECISION_PROBE_NOMINAL_BYTES / 2;

/**
 * Allocate the plant, hold it reachable from the renderer's global object, and
 * answer the character the flattening read saw.
 *
 * The code comes back rather than staying in the renderer because the flattening is
 * what MAKES the plant four megabytes: a repeat answers a rope of concatenation
 * cells weighing a few hundred bytes, and a plant left in that form would fail the
 * arm below for a reason that has nothing to do with the reader it is testing. A
 * value the caller asserts on is a flattening that cannot be silently dropped.
 */
function plantRetainedHeapBytes(consoleApplication: ConsoleApplication): Promise<number> {
  return consoleApplication.window.evaluate(
    ([globalName, characterCount]: [string, number]) => {
      // The precision probe's own shape: one flat one-byte string, a byte a character.
      const retained = "x".repeat(characterCount);
      (globalThis as unknown as Record<string, unknown>)[globalName] = retained;
      return retained.charCodeAt(characterCount - 1);
    },
    [PLANTED_ALLOCATION_GLOBAL, PRECISION_PROBE_NOMINAL_BYTES] as [string, number],
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
          "the plant was not flattened, so what is held on the global is a rope of a few hundred bytes rather than the four megabytes the arms below are about",
        ).toBe("x".charCodeAt(0));
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

  it("refuses the reading a launch without the precise instrument serves", async () => {
    // THE NEGATIVE CONTROL FOR THE PRECONDITION ITSELF. Every other case in this tier
    // calls `expectPreciseHeapInstrument` and passes, which establishes that it
    // ACCEPTS a precise instrument and nothing at all about whether it would accept a
    // coarse one — and a precondition that accepts both is a line of code, not a gate.
    // So the same probe is run against the same console launched without the switch,
    // and the assertion is that it REFUSES.
    //
    // A whole second Electron for one assertion, and it is the cheap option: the
    // alternative is arithmetic over readings pasted into a comment, which proves the
    // arithmetic and not the instrument, and which goes on passing after Blink changes
    // what the default form reports. Measured on this build, the coarse launch answers
    // both reads from one cached value and the difference is exactly 0 B — the floor
    // is what that trips, and the message names the instrument rather than the number.
    await withLaunchedConsole(COARSE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
      try {
        await expect(
          expectPreciseHeapInstrument(consoleApplication, heapProbe),
          "the precondition accepted a launch that never asked for the precise instrument, so it is asserting nothing on the launches that do",
        ).rejects.toThrow(/quantized, cached MemoryInfo rather than the precise one/);
      } finally {
        await heapProbe.detach();
      }
    });
  });
});
