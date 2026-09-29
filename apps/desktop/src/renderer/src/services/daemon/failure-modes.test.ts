// Failure modes of the outside-world seam.
//
// The class: the bridge is the only place the console reaches something it does not
// own, and it can lie. A scenario engine can outlive the store it feeds and deliver a
// tick into a torn-down subscriber, and a view above then reads a plausible answer
// that is not true, which is the one failure the bridge exists to make impossible.
//
// They live in `bridge/` because the subject is what crosses the seam: the engine's
// lifecycle. The store that receives the delivered events asserts its own admission
// rules in `store/session/failure-modes.test.ts` — the split follows the seam.
//
// The assertion is on the REFUSAL — the dropped-tick count and the tripwire — rather
// than merely on the absence of a crash.

import { beforeEach, describe, expect, it } from "vitest";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { ScenarioEngine, SCENARIO_TICK_MS } from "./engine.fixture.js";
import { FIRST_RUN_SCENARIO } from "../../../../../fixtures/scenarios/first-run.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because the point of these cases is to assert that the
// breach was detected and described — a throw would only prove it was noticed.
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
    // BOTH sinks the engine holds, because a dropped tick has to be dropped for both:
    // the beat emitter carries the session log, and the advance emitter carries the
    // clock a scripted fact with no beat to ride is scheduled against. A teardown that
    // cleared one would leave the other delivering into the same torn-down subscriber.
    const advanceTicks: number[] = [];
    engine.subscribeToAdvances((elapsedMs) => {
      advanceTicks.push(elapsedMs);
    });

    engine.dispose();
    // BOTH entry points, because they are two ways into one drop and a case that
    // exercised one would leave the other free to deliver into the disposed store:
    // `tick()` is what a live engine's own timer calls, and `advance` is what a
    // caller holding a duration calls. The duration is the engine's own tick
    // interval rather than a number chosen here — the magnitude decides nothing
    // after teardown, and a literal invites a reader to look for the meaning it has
    // in the live path.
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
