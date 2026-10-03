// The registry, fixture bridge and subscriber the delivery suite drives, and the session and time
// every subscriber suite shares. The registry takes the engine's clock, not one of its own, so the
// apply queue's coalescing window and the scenario's beats cannot advance independently. The drop
// and retry suites build their own harnesses.
import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";

/** The session every suite drives, named by the scenario rather than by a literal. */
export const SESSION_ID: string = CONCURRENT_STREAMING_SCENARIO.sessionId;

/**
 * The frozen time by which the whole scenario has been delivered, read off the script so it cannot
 * go stale when the script grows.
 */
export const PAST_EVERY_BEAT_MS: number =
  (CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0) + 100;

/** The registry, subscriber and engine a suite drives. */
export interface SubscriberHarness {
  readonly registry: SessionStoreRegistry;
  readonly subscriber: SessionEventSubscriber;
  readonly engine: ScenarioEngine;
}

/**
 * A registry, a fixture bridge and a subscriber over both. The registry's read is registered but
 * resolves `undefined` (the transient miss between reads): registered so the subscriber binds at
 * all, and `undefined` because a base state would initialize the stores and change what
 * `applyBatch` does with each event.
 */
export function createHarness(
  scenario: Scenario = CONCURRENT_STREAMING_SCENARIO,
): SubscriberHarness {
  const { bridge, scenarioEngine: engine } = createFixtureBridge({ scenario });
  const registry = new SessionStoreRegistry({
    read: () => Promise.resolve(undefined),
    clock: engine.clock,
  });
  return { registry, subscriber: new SessionEventSubscriber({ registry, bridge }), engine };
}
