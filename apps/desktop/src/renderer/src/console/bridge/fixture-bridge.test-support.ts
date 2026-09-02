// What every fixture-bridge suite needs before it can ask the bridge anything.
//
// One home for the three roles more than one of the sibling suites plays: the
// fixture and the engine driving it, the two ways a surface reaches that bridge —
// a subscription and a call — and the macrotask drain the settling cases wait on.
// It holds nothing a single suite uses: the scripts each concern re-writes, and the
// constants only one of them reads, stay beside their reader.

import type { DaemonEvent, DaemonMethod } from "@ai-sidekicks/contracts";

import { createFixtureBridge } from "./fixture-bridge.js";
import type { ScenarioEngine } from "./scenario-engine.js";
import type { ConsoleScenario, ScenarioBeat } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import type { ConsoleSessionEvent } from "../store/index.js";

/** The scripted latency both settling suites spend. Longer than one tick. */
export const SCRIPTED_LATENCY_MS = 120;

/** The one call both settling suites script a resolving answer for. */
export const DELAYED_CALL = "agent.list";

/** What that call resolves to, asserted verbatim so a stub cannot pass. */
export const DELAYED_RESULT: { readonly agents: readonly unknown[] } = { agents: [] };

/** The run this file's run-transition beats are about. */
export const PROBE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

/**
 * One run-transition beat, in the shape the shipped scenarios script one.
 *
 * Here rather than in either suite because both of them script transitions and
 * neither owns the shape: the run-stream delivery suite drives it through the
 * bridge and the projector suite drives it directly, and two copies would drift on
 * the day the envelope grows a member.
 */
export function runTransitionBeat(payload: Readonly<Record<string, unknown>>): ScenarioBeat {
  return {
    atMs: 0,
    event: {
      id: "019b79ee-0280-7ea1-8110-e5e0d1150077",
      sessionId: FLAGSHIP_SCENARIO.sessionId,
      sequence: 1,
      kind: "run.running",
      occurredAt: "2026-01-01T14:20:00.500Z",
      payload,
    },
  };
}

export interface FixtureUnderTest {
  readonly bridge: ReturnType<typeof createFixtureBridge>;
  readonly engine: ScenarioEngine;
}

/** The real fixture bridge over a real scenario, and the real engine driving it. */
export function createFixture(scenario: ConsoleScenario = FLAGSHIP_SCENARIO): FixtureUnderTest {
  const bridge = createFixtureBridge({ scenario });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
  return { bridge, engine };
}

/**
 * Subscribe through the bridge exactly as a surface would.
 *
 * The event name is cast to the `DaemonEvent` brand and the payload left
 * `unknown` — the same single brand bypass the two shipped renderer families
 * make, because `DaemonEvent` is a `never`-shaped Plan-007 stub and a tighter
 * payload type here would be a fiction.
 *
 * The delivered type is a PARAMETER because the answer depends on the name: the
 * whole-session stream and a bare event type deliver the envelope, and the two
 * narrowed run streams deliver the registered projection. Defaulting it to the
 * envelope keeps every existing caller reading as it did while letting the
 * run-stream suite name what it actually receives instead of asserting through a
 * type that is wrong for it.
 */
export function subscribeThroughBridge<Delivered = ConsoleSessionEvent>(
  fixture: FixtureUnderTest,
  eventName: string,
): readonly Delivered[] {
  const received: Delivered[] = [];
  fixture.bridge.sidekicks.daemon.subscribe(eventName as DaemonEvent, (payload: unknown) => {
    received.push(payload as Delivered);
  });
  return received;
}

export function callThroughBridge(fixture: FixtureUnderTest, method: string): Promise<unknown> {
  return fixture.bridge.sidekicks.daemon.call(method as DaemonMethod, undefined);
}

/**
 * Let every pending microtask chain run.
 *
 * A macrotask boundary rather than a counted number of `await`s: the old
 * behaviour settled a delayed reply two or three microtasks deep, so a count
 * would have to be tuned against the implementation it is meant to hold.
 */
export function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
