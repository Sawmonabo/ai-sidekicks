// Drives the frozen clock a mounted console runs on. The fixture bridge makes the scenario's clock
// the only clock the renderer reads in fixture mode, so every deadline a window arms (a store's
// apply window, a refresh scheduler's debounce, the engine's beats) fires only when a driver
// moves it. A tier that mounts a whole console therefore has to walk that clock, and this module
// is the one walk. It is more than playing the script: a window's first read gives its session
// store a base state and is debounced on this clock, so a scenario with no beats still has to be
// walked or the console draws its loading state forever. Held apart from `app-harness.ts`, which
// settles React turns, so a mount does not make every tier pay for a walk most do not want.

import { act } from "@testing-library/react";

import { APPLY_COALESCE_MS, REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SCENARIO_FIXTURE_GLOBAL } from "@renderer/app/fixture-global-names.js";
import type { ScenarioFixtureHandle } from "@renderer/services/daemon/selection.fixture.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

/**
 * How many advances the whole script is walked in, and how many drain it. Steps rather than one
 * jump: a beat delivered into a store is applied through a coalescing window armed on the same
 * frozen clock, and the engine emits its beats after moving the clock, so one advance past the
 * last beat leaves the last batch queued behind a deadline nothing reaches. The drain advances
 * carry that window past its deadline: every beat in, nothing in flight.
 */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/**
 * The running scenario's handle, or a throw. A throw rather than a skip: a run that could not
 * drive the workload photographed an idle console, and reporting that as a pass is worse than
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
        "any capture taken here would be of a console no scenario ever reached",
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
  // A step clears both deadlines a window arms on this clock: the store's apply window (so every
  // step also drains the batch the step before it delivered) and the refresh debounce the first
  // read waits behind.
  const stepMs = Math.max(
    APPLY_COALESCE_MS + 1,
    REFRESH_DEBOUNCE_MS + 1,
    Math.ceil(lastBeatAtMs / SCENARIO_DELIVERY_STEP_COUNT),
  );
  for (let step = 0; step < SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT; step += 1) {
    await act(async () => {
      control.advance(stepMs);
      await crossMacrotaskBoundary();
    });
  }
  return control.deliveredBeatCount();
}
