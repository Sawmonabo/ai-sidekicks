// Tier: endurance — `Spec-023 §Console Test Tiers`.
//
// Every other tier opens the console, asserts, and closes. A desktop console is
// not used that way: it is left open for a working day while events arrive, and
// the defects that matter over that span are invisible in a run that lasts two
// seconds. A listener the frame subscribes and never unsubscribes, a store that
// appends to an array it never trims, a detached DOM node held by a closure —
// none of them fail a fast tier, and all of them end the day as a console the
// person has to restart.
//
// WHAT THIS TIER MEASURES, AND WHAT IT REFUSES TO
//
// It measures the STEADY-STATE heap: the reading after the application has
// settled, against the reading after a long stretch of the same work. That
// difference is the leak signal — a number that should be near zero regardless
// of how much work happened in between, which is what makes it a usable gate.
//
// It deliberately does not measure the peak, the growth curve, or the absolute
// heap at any single instant. Those are budget-tier questions
// (`test/console/budget/`), they are measured there against `budgets.json`, and
// re-asserting them here would put one number under two owners — the failure mode
// where a budget is loosened in one file and still enforced in the other.
//
// WHY THE FIXTURE SCENARIO IS THE WORKLOAD
//
// The console has no live wire yet, so the only source of sustained change is the
// fixture bridge's scenario engine — which is the right source anyway: it is
// deterministic, it drives the same store paths a daemon would, and its clock is
// frozen, so a slow runner produces the same sequence of states as a fast one and
// this tier's result does not depend on the machine it ran on.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  TRIPWIRE_FIXTURE_GLOBAL,
  fixtureBundleExists,
  launchConsole,
} from "../electron-harness.js";
import type { ConsoleApplication } from "../electron-harness.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How many settle-and-churn cycles the run performs.
 *
 * Set from the measurement rather than from an estimate: a cycle costs roughly
 * 50 ms of driven interaction, so this many keeps the whole tier under a minute
 * while making a leak of ~40 kB per cycle reach the ceiling below. Sensitivity is
 * what the count buys — at a tenth of it the smallest detectable leak is a tenth
 * as sharp — and a leak smaller than that is below what this instrument can see,
 * which the tier says rather than pretending to a precision it does not have.
 */
const CHURN_CYCLE_COUNT = 200;

/**
 * The growth a run may show and still pass.
 *
 * Not zero, and not a percentage. Not zero because V8 keeps its own caches, code
 * objects, and deoptimization data alive across a run and none of that is a leak.
 * Not a percentage because a percentage of a large baseline is a large absolute
 * allowance — the thing being bounded is the leak, and a leak's size has nothing
 * to do with how big the application was to begin with.
 */
const STEADY_HEAP_GROWTH_CEILING_BYTES = 8 * 1024 * 1024;

/**
 * Read the renderer's heap after asking it to collect.
 *
 * `--expose-gc` is not passed and deliberately not required: the reading is taken
 * as the MINIMUM over several samples with a yield between them, which lets the
 * incremental collector run and gives a floor that is far more stable than a
 * single sample. A tier that depended on a non-default Electron flag would be a
 * tier CI silently stopped running the day the flag was dropped.
 */
async function readSettledHeapBytes(consoleApplication: ConsoleApplication): Promise<number> {
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

/**
 * One cycle of the work a console does while a person watches it.
 *
 * Navigation and palette use rather than synthetic allocation, because the leaks
 * worth catching live in the machinery those exercise — subscriptions, effects,
 * portals, and the listener table — and a loop that allocated arrays would prove
 * only that V8 collects arrays.
 */
async function churnOnce(consoleApplication: ConsoleApplication): Promise<void> {
  const consoleWindow = consoleApplication.window;
  await consoleWindow.keyboard.press("ControlOrMeta+KeyK");
  await consoleWindow.getByRole("dialog").waitFor({ state: "visible" });
  await consoleWindow.keyboard.type("Go to");
  await consoleWindow.keyboard.press("Escape");
  await consoleWindow.getByRole("dialog").waitFor({ state: "hidden" });

  // Route changes mount and unmount the surface subtree through the error
  // boundary's keyed remount — the path most likely to strand a listener.
  await consoleWindow.evaluate(() => {
    globalThis.location.hash = "#/settings";
  });
  await consoleWindow.locator(".meridian-frame").waitFor({ state: "visible" });
  await consoleWindow.evaluate(() => {
    globalThis.location.hash = "#/sessions";
  });
  await consoleWindow.locator(".meridian-frame").waitFor({ state: "visible" });
}

describe.skipIf(!bundleIsBuilt)("endurance — the console held open", () => {
  it("does not grow its steady-state heap across sustained use", async () => {
    const consoleApplication = await launchConsole();
    try {
      // One warm-up cycle before the baseline. Without it the baseline is taken
      // before the palette, its portal, and the settings route have ever been
      // constructed, and their one-time allocation would be reported as growth —
      // a tier that failed on first use of a feature rather than on a leak.
      await churnOnce(consoleApplication);
      const baselineHeapBytes = await readSettledHeapBytes(consoleApplication);

      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        await churnOnce(consoleApplication);
      }

      const finalHeapBytes = await readSettledHeapBytes(consoleApplication);
      const growthBytes = finalHeapBytes - baselineHeapBytes;

      // Reported before the assertion so a passing run still records the number.
      // A gate that only speaks when it fails gives a reviewer no way to see a
      // margin shrinking over months until the day it crosses.
      const growthKilobytes = Math.round(growthBytes / 1024);
      const perCycleBytes = Math.round(growthBytes / CHURN_CYCLE_COUNT);
      process.stdout.write(
        `[console-endurance] baseline ${String(Math.round(baselineHeapBytes / 1024))} kB, ` +
          `final ${String(Math.round(finalHeapBytes / 1024))} kB, ` +
          `growth ${String(growthKilobytes)} kB over ${String(CHURN_CYCLE_COUNT)} cycles ` +
          `(${String(perCycleBytes)} B/cycle)\n`,
      );

      expect(growthBytes).toBeLessThanOrEqual(STEADY_HEAP_GROWTH_CEILING_BYTES);
    } finally {
      await consoleApplication.close();
    }
  });

  it("leaves no tripwire firing after sustained use", async () => {
    // The heap is one signal and a coarse one. The console reports every
    // invariant breach it detects through its own tripwire registry — an
    // apply-chokepoint bypass, a persistence value-class refusal, a bridge-shape
    // drift — and a run this long is the best chance any of them has to fire.
    // Asserting the registry is empty at the end is a much sharper claim than the
    // heap bound and costs one evaluate.
    const consoleApplication = await launchConsole();
    try {
      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        await churnOnce(consoleApplication);
      }
      const firings = await consoleApplication.window.evaluate((globalName: string) => {
        const registry = (
          globalThis as unknown as Record<string, { reports(): readonly unknown[] } | undefined>
        )[globalName];
        return registry === undefined ? null : [...registry.reports()];
      }, TRIPWIRE_FIXTURE_GLOBAL);

      // Absence is a FAILURE, not a reason to skip. A fixture build that did not
      // expose the registry would make this test pass while checking nothing, and
      // a check that cannot fail is the one kind of test worth deleting. The
      // property name is pinned to the renderer module that sets it by the
      // architecture tier, so the two sides cannot drift into a vacuous pass.
      expect(firings, `${TRIPWIRE_FIXTURE_GLOBAL} is not exposed by this build`).not.toBeNull();
      expect(firings).toStrictEqual([]);
    } finally {
      await consoleApplication.close();
    }
  });
});
