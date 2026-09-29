// The handle a Playwright driver holds on the running scenario.
//
// It is called from OUTSIDE this process, so every case below pins a fact that end
// depends on. Each has a negative control, because a handle that answered a constant
// would satisfy the positive half of every one of them.

import { describe, expect, it } from "vitest";

import { ScenarioFixtureControl } from "./selection.fixture.js";
import { ScenarioEngine } from "./engine.fixture.js";
import {
  CONCURRENT_STREAMING_SCENARIO,
  CONCURRENT_STREAMING_SCENARIO_ID,
} from "../../../../../fixtures/scenarios/concurrent-streaming.js";

describe("ScenarioFixtureControl — the handle a driver holds", () => {
  it("names the scenario its engine is playing", () => {
    const control = new ScenarioFixtureControl(
      new ScenarioEngine({ scenario: CONCURRENT_STREAMING_SCENARIO }),
    );
    expect(control.scenarioId).toBe(CONCURRENT_STREAMING_SCENARIO_ID);
  });

  it("delivers beats as it advances, and counts them", () => {
    const engine = new ScenarioEngine({ scenario: CONCURRENT_STREAMING_SCENARIO });
    const control = new ScenarioFixtureControl(engine);
    const lastBeatMs = CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0;

    // Negative control for the counter: a handle answering a constant would
    // satisfy the growth assertions below without ever moving the engine.
    expect(control.deliveredBeatCount()).toBe(0);

    control.advance(1);
    const afterFirstAdvance = control.deliveredBeatCount();
    expect(afterFirstAdvance).toBeGreaterThan(0);

    control.advance(lastBeatMs);
    expect(control.deliveredBeatCount()).toBeGreaterThan(afterFirstAdvance);
    expect(control.deliveredBeatCount()).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);
  });
});
