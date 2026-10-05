// How a frozen scenario clock is walked over a script so every beat is in and nothing is queued.
//
// Steps rather than one jump: a delivered beat is applied through a coalescing window armed on the
// same frozen clock, and the engine emits its beats after moving the clock, so one advance past
// the last beat leaves the last batch queued behind a deadline nothing reaches. The drain steps
// carry that window past its deadline. Every endurance walker, in the driver process or inside
// the renderer, takes its steps from here.

import { APPLY_COALESCE_MS, REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh/caps.js";

/** How many advances the whole script is walked in, and how many drain it. */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/** How the frozen clock is walked over a script, and how far. */
export interface ScenarioDeliverySchedule {
  readonly stepMilliseconds: number;
  readonly stepCount: number;
}

/**
 * The walk for a script whose last beat lands at `lastBeatAtMs`. Each step clears both deadlines
 * a window arms on this clock, the store's apply window and the refresh debounce a first read
 * waits behind, so every step also drains the batch the step before it delivered.
 */
export function scenarioDeliverySchedule(lastBeatAtMs: number): ScenarioDeliverySchedule {
  return {
    stepMilliseconds: Math.max(
      APPLY_COALESCE_MS + 1,
      REFRESH_DEBOUNCE_MS + 1,
      Math.ceil(lastBeatAtMs / SCENARIO_DELIVERY_STEP_COUNT),
    ),
    stepCount: SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT,
  };
}
