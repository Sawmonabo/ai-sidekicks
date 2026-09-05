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
// WHAT THIS FILE MEASURES, AND WHAT IT REFUSES TO
//
// It measures the STEADY-STATE heap: the reading after the application has
// settled, against the reading after a long stretch of the same work. That
// difference is the leak signal — a number that should be near zero regardless
// of how much work happened in between, which is what makes it a usable gate.
//
// It deliberately does not measure the peak or the growth curve. The absolute
// heap at one instant is a BUDGET question and is answered by this tier's
// `heap-at-rest.test.ts` against `budgets.json`; re-asserting a ceiling here
// would put one number under two owners — the failure mode where a budget is
// loosened in one file and still enforced in the other.
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
// wants — `withLaunchedConsole({ scenarioId }, …)`, which the main process turns into a
// document-URL query the renderer reads once at boot — because the default is the
// first-run scenario, whose script is one beat long by design. And it advances the
// frozen clock on every churn cycle through the fixture-only handle the bridge
// provider installs, by a budget derived from the script's own length so the whole
// run walks it about once. The beats the engine delivered are then read back and
// asserted to GROW, because a run that never moved the clock looks exactly as busy
// while delivering nothing — that count is the evidence the workload was a
// workload.
//
// The second reading is the session store's, and it is asserted to GROW. The
// fixture bridge serves the growth port's session read, so a store this window
// opens reaches a base state, the binder takes the wire subscription, and the
// scenario's beats travel the whole path a daemon's would: subscription, apply
// chokepoint, store. That is what makes this a workload rather than a navigation
// loop — a console left open for a working day is one with events landing in
// stores, and the leaks worth catching live in that machinery.
//
// The reading is taken THREE times — after the warm-up, half way, and at the end —
// and each is asserted strictly greater than the last. One end-to-end comparison
// would pass over a run that delivered its whole script inside the warm-up cycle
// and then sat idle for two hundred, which is the shape a leak hides in most
// comfortably. `SCENARIO_ADVANCE_MS_PER_CYCLE` is derived from the script's own
// span for exactly this reason: the run walks the script about once, so its beats
// fall across the cycles rather than at the front of them, and the mid-run reading
// is what proves it.
//
// Absence is still a failure and never a skip: the diagnostics handle is installed
// on both arms, and a build without it would make every reading below vacuous.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedConsole } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
} from "../fixture-handles.js";
import {
  churnOnce,
  ENDURANCE_LAUNCH_OPTIONS,
  FLAGSHIP_SESSION_ID,
  openFlagshipSessionRoute,
  openSettingsRoute,
  readAppliedEventCount,
  readBoundSessionIds,
  readPlayingScenarioId,
  readSettledHeapBytes,
  SETTINGS_SURFACE_SELECTOR,
  WORKSPACE_SURFACE_SELECTOR,
} from "./console-workload.js";
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

describe.skipIf(!bundleIsBuilt)("endurance — the console held open", () => {
  // The proof that every reading below describes a console that actually
  // navigated. A churn cycle is two route changes, and the run only measures the
  // mount and unmount churn it claims to if each change is OBSERVED before the
  // next hash is assigned. The cycle used to wait on `.meridian-frame`, which is
  // the window's permanent shell: it was already on the page, so the wait
  // returned at once and the second assignment could land before React had
  // mounted the first destination at all.
  //
  // This is the assertion that catches that, and it catches it by construction
  // rather than by inspection — the locators asserted route-exclusive here are
  // the same two constants `churnOnce` waits on, so a wait re-pointed at any
  // element both routes render fails on the two absence checks below.
  it("waits on a surface that only its own destination renders", async () => {
    await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const consoleWindow = consoleApplication.window;

      // `openSettingsRoute` has already waited for its own locator, so the
      // positive half is the wait itself. What is asserted here is the half a
      // wait cannot make: that the OTHER route's locator is absent, which is what
      // a locator naming the permanent shell could never satisfy.
      await openSettingsRoute(consoleApplication);
      expect(await consoleWindow.locator(SETTINGS_SURFACE_SELECTOR).count()).toBeGreaterThan(0);
      expect(
        await consoleWindow.locator(WORKSPACE_SURFACE_SELECTOR).count(),
        "the workspace wait is satisfied on the settings route, so a churn cycle never observes the transition into the workspace",
      ).toBe(0);

      await openFlagshipSessionRoute(consoleApplication);
      expect(await consoleWindow.locator(WORKSPACE_SURFACE_SELECTOR).count()).toBeGreaterThan(0);
      expect(
        await consoleWindow.locator(SETTINGS_SURFACE_SELECTOR).count(),
        "the settings wait is satisfied on the workspace route, so a churn cycle never observes the transition into settings",
      ).toBe(0);
    });
  });

  it("does not grow its steady-state heap across sustained use", async () => {
    await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
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
      const beatsAfterWarmUp = await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
      const appliedEventsAfterWarmUp = await readAppliedEventCount(
        consoleApplication,
        FLAGSHIP_SESSION_ID,
      );
      const baselineHeapBytes = await readSettledHeapBytes(consoleApplication);

      let beatsDelivered = beatsAfterWarmUp;
      let appliedEventsAtMidRun: number | null = null;
      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        beatsDelivered = await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
        if (cycle === Math.floor(CHURN_CYCLE_COUNT / 2)) {
          appliedEventsAtMidRun = await readAppliedEventCount(
            consoleApplication,
            FLAGSHIP_SESSION_ID,
          );
        }
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
          `${String(appliedEventsAfterWarmUp)} → ${String(appliedEventsAtMidRun)} → ` +
          `${String(appliedEventCount)}\n`,
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
      expect(appliedEventsAtMidRun).not.toBeNull();

      // The events kept arriving for the whole run rather than in a burst at the
      // front of it. Both comparisons are strict, and both are load-bearing: the
      // first says the workload was still delivering at the half-way point, the
      // second that it was still delivering at the end.
      expect(
        Number(appliedEventsAtMidRun),
        "the scenario stopped delivering into the store before the run was half over",
      ).toBeGreaterThan(Number(appliedEventsAfterWarmUp));
      expect(
        Number(appliedEventCount),
        "the scenario stopped delivering into the store part-way through the run",
      ).toBeGreaterThan(Number(appliedEventsAtMidRun));

      // And they reached a store through a real subscription rather than a
      // side channel. This is what fails the day the console goes back to binding
      // nothing — the reading that was zero in every build before the session read
      // had a producer, which made this whole tier an idle loop wearing a
      // workload's name.
      expect(await readBoundSessionIds(consoleApplication)).toContain(FLAGSHIP_SESSION_ID);
    });
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
    await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      for (let cycle = 0; cycle < CHURN_CYCLE_COUNT; cycle += 1) {
        await churnOnce(consoleApplication, SCENARIO_ADVANCE_MS_PER_CYCLE);
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
    });
  });
});
