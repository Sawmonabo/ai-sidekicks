// The handle a Playwright driver holds on the running scenario.
//
// It is called from OUTSIDE this process, so every case below pins a fact that end
// depends on. Each has a negative control, because a handle that answered a constant
// would satisfy the positive half of every one of them.

import { describe, expect, it } from "vitest";

import { SCENARIO_FIXTURE_GLOBAL } from "@renderer/console/bridge/scenario/selection.js";
import { ScenarioFixtureControl } from "./selection.fixture.js";
import { ScenarioEngine } from "./engine.fixture.js";
import {
  FLAGSHIP_SCENARIO,
  FLAGSHIP_SCENARIO_ID,
} from "../../../../../fixtures/scenarios/concurrent-streaming.js";

describe("ScenarioFixtureControl — the handle a driver holds", () => {
  it("names the scenario its engine is playing", () => {
    const control = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));
    expect(control.scenarioId).toBe(FLAGSHIP_SCENARIO_ID);
  });

  it("delivers beats as it advances, and counts them", () => {
    const engine = new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO });
    const control = new ScenarioFixtureControl(engine);
    const lastBeatMs = FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0;

    // Negative control for the counter: a handle answering a constant would
    // satisfy the growth assertions below without ever moving the engine.
    expect(control.deliveredBeatCount()).toBe(0);

    control.advance(1);
    const afterFirstAdvance = control.deliveredBeatCount();
    expect(afterFirstAdvance).toBeGreaterThan(0);

    control.advance(lastBeatMs);
    expect(control.deliveredBeatCount()).toBeGreaterThan(afterFirstAdvance);
    expect(control.deliveredBeatCount()).toBe(FLAGSHIP_SCENARIO.beats.length);
  });

  it("installs under one name and removes itself on teardown", () => {
    const target: Record<string, unknown> = {};
    const control = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));

    // Constructing installs nothing: the property appears at `install` and only
    // there, which is what keeps the one call site inside the fixture guard.
    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBeUndefined();

    const remove = control.install(target);
    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBe(control);

    remove();
    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBeUndefined();
  });

  it("a superseded control's teardown leaves the live one installed", () => {
    // Several consoles mount into one document in the browser tiers. An
    // unconditional delete on the first one's unmount would strip the handle the
    // second had just installed, and the tier reading it would see nothing.
    const target: Record<string, unknown> = {};
    const first = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));
    const second = new ScenarioFixtureControl(new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO }));

    const removeFirst = first.install(target);
    second.install(target);
    removeFirst();

    expect(target[SCENARIO_FIXTURE_GLOBAL]).toBe(second);
  });
});
