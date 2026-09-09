// Driving the frozen clock a mounted console is running on.
//
// THE ROLE, STATED ONCE. `Spec-023 §Console Design (Meridian)` §The fixture bridge
// makes the scenario's clock the only clock the renderer reads in fixture mode, so
// every deadline a mounted window arms — a store's apply window, a refresh
// scheduler's debounce, the engine's own beats — is armed on it and fires when a
// driver moves it and at no other moment. A tier that mounts a whole console and
// then reads anything off it therefore has to walk that clock, and this module is
// where the walk lives so that two tiers cannot walk it two different ways.
//
// AND THE SECOND HALF IS WHY IT IS NOT JUST "PLAY THE SCRIPT". A window's own first
// read is what gives its session store a base state, and it is debounced on this same
// clock — so a scenario with no beats at all still has to be walked, or the console
// on screen is one that has been told nothing about the session it is showing and
// draws its loading state forever. That was a real reference: the ledger's empty-state
// baseline was minted over twelve loading shells and a cast bar reading "Nobody has
// joined this session yet." for a scenario whose whole subject is its roster.
//
// Held apart from `console-harness.tsx`, which mounts and settles React turns: turns
// and frozen time are two different things to wait on, and a mount that settled both
// would make every tier pay for a walk most of them do not want.

import { act } from "@testing-library/react";

import {
  APPLY_COALESCE_MS,
  REFRESH_DEBOUNCE_MS,
  SCENARIO_FIXTURE_GLOBAL,
} from "../../src/renderer/src/console/core/index.js";
import type { ScenarioFixtureHandle } from "../../src/renderer/src/console/bridge/scenario/selection.js";
import { crossMacrotaskBoundary } from "../../src/renderer/src/console/core/macrotask-boundary.test-support.js";

/**
 * How many advances the whole script is walked in, and how many drain it.
 *
 * Steps rather than one jump, on `test/console/endurance/console-workload.ts`'
 * reasoning: a beat delivered into a store is applied through a coalescing window
 * armed on the same frozen clock, and the engine emits its beats AFTER moving the
 * clock — so one advance past the last beat delivers every one of them and leaves
 * the last batch queued behind a deadline nothing will ever reach. The drain
 * advances carry that window past its deadline with nothing left to deliver, which
 * is the quiet point a baseline has to be captured at: every beat in, nothing in
 * flight.
 */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/**
 * The running scenario's handle, or a throw.
 *
 * A throw rather than a skip, on the endurance tier's posture: a run that could not
 * drive the workload photographed an idle console, and reporting that as a pass is
 * worse than not running at all. The handle is installed by the bridge provider's
 * effect under the same `define` gate as the fixture bridge itself, so it is on the
 * page by the time a settled mount returns.
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
 * Walk the frozen clock to the script's last beat and let the stores settle on it.
 *
 * Each advance is wrapped in `act` because the drain it releases lands in a store
 * whose subscribers are React components: outside `act` those updates settle after
 * the awaited turn rather than before it, which React reports as a warning and a
 * capture observes as a frame one commit behind the state it is claiming to pin.
 *
 * Returns the delivered-beat count, so a caller can assert that the session it is
 * about to read holds exactly the content its own script put there — which is a
 * claim in both directions: every beat for a script that has them, and none at all
 * for a script that has none.
 */
export async function walkScenarioToFrozenTick(lastBeatAtMs: number): Promise<number> {
  const control = requireScenarioControl();
  // A step clears both deadlines a mounted window arms on this clock, so neither is
  // left standing by a walk that ran past it: the store's apply window, so every step
  // also drains the batch the step before it delivered — a shorter step would deliver
  // beats no advance in this loop ever released — and the refresh debounce the first
  // read is armed behind, which the step count alone happened to clear for a scripted
  // scenario and cleared for an empty one only by arithmetic.
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
