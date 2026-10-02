// Drives the frozen clock a mounted app runs on. The fixture bridge makes the scenario's clock
// the only clock the renderer reads in fixture mode, so every deadline a window arms (a store's
// apply window, a refresh scheduler's debounce, the engine's beats) fires only when a driver
// moves it. A tier that mounts a whole app therefore has to walk that clock, and this module
// is the one walk. It is more than playing the script: a window's first read gives its session
// store a base state and is debounced on this clock, so a scenario with no beats still has to be
// walked or the app draws its loading state forever. Held apart from `app-harness.ts`, which
// settles React turns, so a mount does not make every tier pay for a walk most do not want.

import { act } from "@testing-library/react";

import { SCENARIO_FIXTURE_GLOBAL } from "@renderer/app/fixture-global-names.js";
import type { ScenarioFixtureHandle } from "@renderer/services/daemon/selection.fixture.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";
import { scenarioDeliverySchedule } from "../helpers/scenario-delivery-schedule.js";

/**
 * The running scenario's handle, or a throw. A throw rather than a skip: a run that could not
 * drive the workload photographed an idle app, and reporting that as a pass is worse than
 * not running. The bridge provider's effect installs the handle under the same `define` gate as
 * the fixture bridge, so it is on the page once a settled mount returns.
 */
export function requireScenarioControl(): ScenarioFixtureHandle {
  const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
    SCENARIO_FIXTURE_GLOBAL
  ];
  if (control === undefined) {
    throw new Error(
      `${SCENARIO_FIXTURE_GLOBAL} is not on this page, so the frozen clock cannot be advanced and ` +
        "any capture taken here would be of an app no scenario ever reached",
    );
  }
  return control;
}

/**
 * Walks the frozen clock to the script's last beat and lets the stores settle on it. Each advance
 * is wrapped in `act` because the drain lands in a store whose subscribers are React components;
 * outside it the update settles after the awaited turn and a capture sees a frame one commit
 * behind. Returns the delivered-beat count, so a caller can assert the session holds exactly what
 * its script put there, every beat or none.
 */
export async function walkScenarioToFrozenTick(lastBeatAtMs: number): Promise<number> {
  const control = requireScenarioControl();
  const { stepMilliseconds, stepCount } = scenarioDeliverySchedule(lastBeatAtMs);
  for (let step = 0; step < stepCount; step += 1) {
    await act(async () => {
      control.advance(stepMilliseconds);
      await crossMacrotaskBoundary();
    });
  }
  return control.deliveredBeatCount();
}
