// Failure modes of the outside-world seam: the bridge is the only place the console reaches
// something it does not own, and a scenario engine can outlive the store it feeds. A tick
// delivered into a torn-down subscriber would show a plausible answer that is not true, so the
// assertion is on the refusal (the dropped-tick count and the tripwire) and not only on no crash.

import { beforeEach, describe, expect, it } from "vitest";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { ScenarioEngine, SCENARIO_TICK_MS } from "./engine.fixture.js";
import { FIRST_RUN_SCENARIO } from "../../../../../fixtures/scenarios/first-run.js";

// Tripwires throw in development; under test they are recorded, so a case can assert the breach
// was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("failure matrix — a scenario tick arrives after teardown", () => {
  it("drops the tick, counts it, and reports rather than delivering into a dead store", () => {
    const engine = new ScenarioEngine({ scenario: FIRST_RUN_SCENARIO });
    const delivered: ProjectedSessionEvent[][] = [];
    engine.subscribe((events) => {
      delivered.push([...events]);
    });
    // Both sinks: the beat emitter carries the session log and the advance emitter carries the
    // clock, so a teardown that cleared one would leave the other delivering.
    const advanceTicks: number[] = [];
    engine.subscribeToAdvances((elapsedMs) => {
      advanceTicks.push(elapsedMs);
    });

    engine.dispose();
    // Both entry points: `tick()` is what the engine's own timer calls and `advance` what a
    // caller holding a duration calls. The magnitude decides nothing after teardown.
    engine.tick();
    engine.advance(SCENARIO_TICK_MS);

    expect(delivered).toHaveLength(0);
    expect(advanceTicks).toStrictEqual([]);
    expect(engine.droppedTickCount).toBe(2);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(2);
  });

  it("delivers normally before teardown, so the drop is not vacuous", () => {
    const engine = new ScenarioEngine({ scenario: FIRST_RUN_SCENARIO });
    const delivered: ProjectedSessionEvent[][] = [];
    engine.subscribe((events) => {
      delivered.push([...events]);
    });
    const advanceTicks: number[] = [];
    engine.subscribeToAdvances((elapsedMs) => {
      advanceTicks.push(elapsedMs);
    });

    engine.runToCompletion();

    expect(delivered).toHaveLength(1);
    expect(advanceTicks).toHaveLength(1);
    expect(engine.progress.isComplete).toBe(true);
  });
});
