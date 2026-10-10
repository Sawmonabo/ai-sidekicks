// How a frozen scenario clock is walked over a script so every beat is in and nothing is queued.
//
// Steps rather than one jump: a store applies the beats a step delivered on the frame the walker
// runs after it, and a read the store asks for waits behind the refresh debounce armed on the same
// frozen clock, so one advance past the last beat leaves that read behind a deadline nothing
// reaches. The drain steps carry the debounce past its deadline. Every endurance walker, in the
// driver process or inside the renderer, takes its steps from here.

import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";

/** How many advances the whole script is walked in, and how many drain it. */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/**
 * The smallest advance that carries the refresh debounce a window arms on the frozen clock past its
 * end, so a read the batch delivered last asked for has run.
 */
export const SCENARIO_DRAIN_MS: number = REFRESH_DEBOUNCE_MS + 1;

/** How the frozen clock is walked over a script, and how far. */
export interface ScenarioDeliverySchedule {
  readonly stepMilliseconds: number;
  readonly stepCount: number;
}

/**
 * The walk for a script whose last beat lands at `lastBeatAtMs`. Each step clears the refresh
 * debounce a first read waits behind, so every step also runs the read the step before it asked
 * for.
 */
export function scenarioDeliverySchedule(lastBeatAtMs: number): ScenarioDeliverySchedule {
  return {
    stepMilliseconds: Math.max(
      SCENARIO_DRAIN_MS,
      Math.ceil(lastBeatAtMs / SCENARIO_DELIVERY_STEP_COUNT),
    ),
    stepCount: SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT,
  };
}
