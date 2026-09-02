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
//
// A FROZEN CLOCK DOES NOT ADVANCE ITSELF, WHICH IS THE WHOLE POINT
//
// That last property has a consequence this tier has to act on rather than only
// state: nothing in a fixture build moves the clock on its own. A run that only
// navigated and typed would hold the console open over a scenario that had
// delivered its first beat and then stopped — an idle loop wearing a workload's
// name, and green for the same reason it was measuring nothing.
//
// So the run does two things the earlier shape did not. It NAMES the scenario it
// wants — `launchConsole({ scenarioId })`, which the main process turns into a
// document-URL query the renderer reads once at boot — because the default is the
// first-run scenario, whose script is one beat long by design. And it advances the
// frozen clock on every churn cycle through the fixture-only handle the bridge
// provider installs, by a budget derived from the script's own length so the whole
// run walks it about once. The beats the engine delivered are then read back and
// asserted to GROW, because a run that never moved the clock looks exactly as busy
// while delivering nothing — that count is the evidence the workload was a
// workload.
//
// The second reading is the session store's, and it is asserted to stay at ZERO
// rather than to grow. No session read is registered on the console's bridge, so
// no store it opens can reach a base state, so the window's binder takes no wire
// subscription at all rather than feeding a pre-initialisation buffer nothing will
// ever drain. That distinction is exactly this tier's subject: a console left open
// for a working day retaining a stream it cannot project is the leak a two-second
// tier cannot see. Zero is a READING and not an absence — the diagnostics handle is
// installed on that arm too, and the run fails if it is missing.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
  fixtureBundleExists,
  launchConsole,
  type ConsoleSessionDiagnostics,
  type ScenarioFixtureHandle,
} from "../electron-harness.js";
import type { ConsoleApplication } from "../electron-harness.js";
import { FLAGSHIP_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/flagship.js";

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

/** The session the flagship script plays into, and the route this run opens. */
const FLAGSHIP_SESSION_ID = FLAGSHIP_SCENARIO.sessionId;
const FLAGSHIP_SESSION_ROUTE = `#/session/${encodeURIComponent(FLAGSHIP_SESSION_ID)}`;

/**
 * How far the frozen clock moves on each churn cycle.
 *
 * DERIVED from the script rather than picked, so it stays right as the scenario
 * grows: the run's total advance is about the span the script covers, which
 * spreads its beats across the cycles instead of delivering all of them inside the
 * first one. A fixed millisecond budget would have to be re-tuned by hand every
 * time a beat moved, and the failure when nobody did would be a silent one — a
 * fully-delivered script and a growth assertion that could never fire again.
 */
const SCENARIO_ADVANCE_MS_PER_CYCLE = Math.max(
  1,
  Math.ceil((FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0) / CHURN_CYCLE_COUNT),
);

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
 * Move the scenario on, and report how far it has got.
 *
 * `null` means the handle is not on the page at all — which this tier treats as a
 * failure and never as a reason to skip, on the same reasoning the tripwire
 * assertion below states: a run that could not drive the workload measured an idle
 * console, and reporting that as a pass is worse than not running.
 */
async function advanceScenario(
  consoleApplication: ConsoleApplication,
  milliseconds: number,
): Promise<number | null> {
  return consoleApplication.window.evaluate(
    ([globalName, deltaMs]: [string, number]) => {
      const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
        globalName
      ];
      if (control === undefined) {
        return null;
      }
      control.advance(deltaMs);
      return control.deliveredBeatCount();
    },
    [SCENARIO_FIXTURE_GLOBAL, milliseconds] as [string, number],
  );
}

/** Which scenario the launched console is actually playing, or `null`. */
async function readPlayingScenarioId(
  consoleApplication: ConsoleApplication,
): Promise<string | null> {
  return consoleApplication.window.evaluate((globalName: string) => {
    const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
      globalName
    ];
    return control === undefined ? null : control.scenarioId;
  }, SCENARIO_FIXTURE_GLOBAL);
}

/**
 * How many events the store for one session has ADMITTED, or `null`.
 *
 * Admitted to the apply chokepoint, which is a different number from the beats
 * the engine delivered and from anything a timeline is long. That is why both are
 * read: they answer different questions, and this one answers whether a stream
 * reached this window's stores at all.
 */
async function readAppliedEventCount(
  consoleApplication: ConsoleApplication,
  sessionId: string,
): Promise<number | null> {
  return consoleApplication.window.evaluate(
    ([globalName, targetSessionId]: [string, string]) => {
      const sessions = (
        globalThis as unknown as Record<string, ConsoleSessionDiagnostics | undefined>
      )[globalName];
      return sessions === undefined ? null : sessions.appliedEventCountFor(targetSessionId);
    },
    [SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, sessionId] as [string, string],
  );
}

/** Sessions this window holds a wire subscription for, or `null` with no handle. */
async function readBoundSessionIds(
  consoleApplication: ConsoleApplication,
): Promise<readonly string[] | null> {
  return consoleApplication.window.evaluate((globalName: string) => {
    const sessions = (
      globalThis as unknown as Record<string, ConsoleSessionDiagnostics | undefined>
    )[globalName];
    return sessions === undefined ? null : [...sessions.boundSessionIds()];
  }, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL);
}

/**
 * One cycle of the work a console does while a person watches it.
 *
 * Navigation and palette use rather than synthetic allocation, because the leaks
 * worth catching live in the machinery those exercise — subscriptions, effects,
 * portals, and the listener table — and a loop that allocated arrays would prove
 * only that V8 collects arrays. The clock moves once per cycle so the scenario is
 * delivering into that machinery while it is being churned, which is the state a
 * real session is in and the one a leak shows up in.
 *
 * Returns the delivered-beat count the advance reported, so a caller can assert
 * the workload progressed without paying for a second round trip.
 */
async function churnOnce(consoleApplication: ConsoleApplication): Promise<number | null> {
  const consoleWindow = consoleApplication.window;
  await consoleWindow.keyboard.press("ControlOrMeta+KeyK");
  await consoleWindow.getByRole("dialog").waitFor({ state: "visible" });
  await consoleWindow.keyboard.type("Go to");
  await consoleWindow.keyboard.press("Escape");
  await consoleWindow.getByRole("dialog").waitFor({ state: "hidden" });

  // Route changes mount and unmount the surface subtree through the error
  // boundary's keyed remount — the path most likely to strand a listener. One of
  // the two routes is the scenario's own session, so the cycle also opens and
  // re-reads the store the beats are landing in.
  await consoleWindow.evaluate(() => {
    globalThis.location.hash = "#/settings";
  });
  await consoleWindow.locator(".meridian-frame").waitFor({ state: "visible" });
  await consoleWindow.evaluate((sessionRoute: string) => {
    globalThis.location.hash = sessionRoute;
  }, FLAGSHIP_SESSION_ROUTE);
  await consoleWindow.locator(".meridian-frame").waitFor({ state: "visible" });

  return advanceScenario(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
}

describe.skipIf(!bundleIsBuilt)("endurance — the console held open", () => {
  it("does not grow its steady-state heap across sustained use", async () => {
    const consoleApplication = await launchConsole({ scenarioId: FLAGSHIP_SCENARIO.id });
    try {
      // The workload is named before it is measured. A launch that fell back to
      // the first-run scenario would churn a one-beat script and pass every
      // reading below, so this is the negative control for the whole run rather
      // than a sanity check: it fails on exactly the regression — no query, no
      // read, no selection — that makes this tier idle.
      expect(
        await readPlayingScenarioId(consoleApplication),
        `${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build, or the launch did not select a scenario`,
      ).toBe(FLAGSHIP_SCENARIO.id);

      // One warm-up cycle before the baseline. Without it the baseline is taken
      // before the palette, its portal, and the settings route have ever been
      // constructed, and their one-time allocation would be reported as growth —
      // a tier that failed on first use of a feature rather than on a leak.
      const beatsAfterWarmUp = await churnOnce(consoleApplication);
      const appliedEventsAfterWarmUp = await readAppliedEventCount(
        consoleApplication,
        FLAGSHIP_SESSION_ID,
      );
      const baselineHeapBytes = await readSettledHeapBytes(consoleApplication);

      let beatsDelivered = beatsAfterWarmUp;
      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        beatsDelivered = await churnOnce(consoleApplication);
      }

      const finalHeapBytes = await readSettledHeapBytes(consoleApplication);
      const growthBytes = finalHeapBytes - baselineHeapBytes;

      // Reported before the assertion so a passing run still records the number.
      // A gate that only speaks when it fails gives a reviewer no way to see a
      // margin shrinking over months until the day it crosses.
      const growthKilobytes = Math.round(growthBytes / 1024);
      const perCycleBytes = Math.round(growthBytes / CHURN_CYCLE_COUNT);
      const appliedEventCount = await readAppliedEventCount(
        consoleApplication,
        FLAGSHIP_SESSION_ID,
      );
      process.stdout.write(
        `[console-endurance] baseline ${String(Math.round(baselineHeapBytes / 1024))} kB, ` +
          `final ${String(Math.round(finalHeapBytes / 1024))} kB, ` +
          `growth ${String(growthKilobytes)} kB over ${String(CHURN_CYCLE_COUNT)} cycles ` +
          `(${String(perCycleBytes)} B/cycle); beats ${String(beatsAfterWarmUp)} → ` +
          `${String(beatsDelivered)} of ${String(FLAGSHIP_SCENARIO.beats.length)} at ` +
          `${String(SCENARIO_ADVANCE_MS_PER_CYCLE)} ms/cycle; events applied ` +
          `${String(appliedEventsAfterWarmUp)} → ${String(appliedEventCount)}\n`,
      );

      // The workload moved. Both halves are load-bearing: the first says the
      // handle was reachable and the script was running, the second says it kept
      // running rather than emptying itself into the warm-up cycle.
      expect(beatsAfterWarmUp).not.toBeNull();
      expect(beatsDelivered).not.toBeNull();
      expect(Number(beatsDelivered)).toBeGreaterThan(Number(beatsAfterWarmUp));

      expect(growthBytes).toBeLessThanOrEqual(STEADY_HEAP_GROWTH_CEILING_BYTES);

      // Beats delivered by the engine are not the same claim as events reaching a
      // store. Absence is a failure here for the same reason it is for the tripwire
      // registry below — a build without the handle would make this check vacuous.
      expect(
        appliedEventCount,
        `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} is not exposed by this build, so nothing can be shown about where the workload's events went`,
      ).not.toBeNull();
      expect(appliedEventsAfterWarmUp).not.toBeNull();

      // Zero, and zero is the correct number rather than a disappointing one: no
      // session read is registered on this bridge, so no store can be initialised,
      // so the window binds no stream instead of buffering one it will never
      // project. This pair is what fails the day a console starts retaining a
      // stream it cannot render — the leak a day-long session would show first.
      expect(appliedEventCount).toBe(0);
      expect(await readBoundSessionIds(consoleApplication)).toEqual([]);
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
    // heap bound and costs one evaluate. It is re-run here with the clock moving,
    // because the breaches most worth catching are the ones a delivering scenario
    // causes: a beat applied outside the store's chokepoint, a tick that outlived
    // its pane.
    const consoleApplication = await launchConsole({ scenarioId: FLAGSHIP_SCENARIO.id });
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
