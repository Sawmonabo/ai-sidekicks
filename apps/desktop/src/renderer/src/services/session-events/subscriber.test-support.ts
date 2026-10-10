// The registry, fixture bridge and subscriber the delivery suite drives, and the session and time
// every subscriber suite shares. The registry takes the engine's clock, not one of its own, so the
// apply queue's coalescing window and the scenario's beats cannot advance independently. The drop
// and retry suites build their own harnesses.
import { createFixtureBridge } from "../platform/bridge.fixture.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import type { Scenario } from "#fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { openingPageLimit, offScreenRowLimit } from "#test/helpers/session/store/fixtures.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { SessionEventSubscriber } from "./subscriber.js";

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
 * A registry, a fixture bridge and a subscriber over both. The registry's read lands an empty base
 * state at the bottom of the stream with no position, so a session's stream opens from the start
 * of the log once that read has landed (`landReads`).
 */
export function createHarness(
  scenario: Scenario = CONCURRENT_STREAMING_SCENARIO,
): SubscriberHarness {
  const { bridge, scenarioEngine: engine } = createFixtureBridge({ scenario });
  const registry = new SessionStoreRegistry({
    read: () => Promise.resolve({ entities: [] }),
    clock: engine.clock,
    openingPageLimit,
    offScreenRowLimit,
    refreshDebounceMs: 0,
  });
  return { registry, subscriber: new SessionEventSubscriber({ registry, bridge }), engine };
}

/**
 * Let every read asked for so far land, and the streams waiting on them open: the reads fall due
 * on the frozen clock and settle across a macrotask.
 */
export async function landReads(engine: ScenarioEngine): Promise<void> {
  engine.advance(0);
  await crossMacrotaskBoundary();
}
