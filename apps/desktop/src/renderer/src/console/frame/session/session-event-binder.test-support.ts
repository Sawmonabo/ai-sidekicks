// The three pieces every binder suite needs, built once.
//
// Three suites drive this class — deliveries (`session-event-binder.test.ts`), the
// payload boundary (`.payload.test.ts`), and the opens that failed (`.retry.test.ts`)
// — and the first two want an identical registry, fixture bridge and binder over both.
// Copied into each file, the copies drift: the registry's clock is the subtle one,
// because a registry given a clock of its own rather than the ENGINE's would let the
// apply queue's coalescing window and the scenario's beats advance independently, and
// every timing assertion in that suite would quietly become a measurement of its own
// harness. One builder is one clock.
//
// The retry suite builds its own instead, over a transport scripted to refuse: that
// harness records the reasons its read was performed for and counts refusals, which
// no delivery case needs, and folding both shapes into one builder would give every
// caller a parameter it passes the same way.

import { createFixtureBridge } from "../../bridge/index.js";
import type { ScenarioEngine } from "../../bridge/scenario-runtime/scenario-engine.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { SessionStoreRegistry } from "../../store/index.js";
import { SessionEventBinder } from "./session-event-binder.js";

/** The session every suite drives, named by the scenario rather than by a literal. */
export const SESSION_ID: string = FLAGSHIP_SCENARIO.sessionId;

/** The whole scenario is delivered by this much frozen time; its last beat is at 400. */
export const PAST_EVERY_BEAT_MS = 500;

export interface BinderHarness {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventBinder;
  readonly engine: ScenarioEngine;
}

/**
 * A registry, a fixture bridge, and a binder over both.
 *
 * The registry's read is a REGISTERED one that happens to find nothing — the transient
 * miss, which is what a session whose wire exists looks like between reads. It has to
 * be registered for the binder to bind at all, and it has to resolve `undefined` rather
 * than a snapshot, because a snapshot would initialise the stores and change what
 * `applyBatch` does with every event a case delivers.
 */
export function createHarness(scenario: ConsoleScenario = FLAGSHIP_SCENARIO): BinderHarness {
  const bridge = createFixtureBridge({ scenario });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
  const registry = new SessionStoreRegistry({
    read: () => Promise.resolve(undefined),
    clock: engine.clock,
  });
  return { registry, binder: new SessionEventBinder({ registry, bridge }), engine };
}
