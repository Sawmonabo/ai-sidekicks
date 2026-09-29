// What every fixture-bridge suite needs before it can ask the bridge anything.
//
// One home for the roles more than one of the sibling suites plays: the fixture and
// the engine driving it, the two ways a surface reaches that bridge — a subscription
// and a call — and the bridge whose call arm a suite decides the answer for. It
// holds nothing a single suite uses: the scripts each concern re-writes, and the
// constants only one of them reads, stay beside their reader.
//
// The macrotask wait the settling cases use is a timing helper, so it lives in
// `macrotask-boundary.ts`.

import type { DaemonEvent, DaemonMethod, EventEnvelope } from "@ai-sidekicks/contracts";
import type { Unsubscribe } from "@shared/preload-api.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Clock } from "@renderer/lib/clock.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import type { Scenario, ScenarioBeat } from "../../fixtures/scenario.js";
import type { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";

/** The scripted latency both settling suites spend. Longer than one tick. */
export const SCRIPTED_LATENCY_MS = 120;

/** The one call both settling suites script a resolving answer for. */
export const DELAYED_CALL = "agent.list";

/** What that call resolves to, asserted verbatim so a stub cannot pass. */
export const DELAYED_RESULT: { readonly agents: readonly unknown[] } = { agents: [] };

/** The run this file's run-transition beats are about. */
export const PROBE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

export interface FixtureUnderTest {
  readonly bridge: ReturnType<typeof createFixtureBridge>;
  readonly engine: ScenarioEngine;
}

/** What the daemon was asked, so a case can assert it was never asked at all. */
export interface RecordedDaemonCall {
  readonly method: string;
  readonly params: unknown;
}

/** A bridge whose call arm answers as the suite says, and the record of what it was asked. */
export interface BridgeUnderTest {
  readonly bridge: PlatformBridge;
  readonly calls: readonly RecordedDaemonCall[];
}

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
      sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
      sequence: 1,
      kind: "run.running",
      occurredAt: "2026-01-01T14:20:00.500Z",
      payload,
    },
  };
}

/**
 * The tick a scenario's last beat falls due at.
 *
 * Read off the script rather than written as a number, because the seat board's
 * scripts grow: a hardcoded "past every beat" tick silently stops covering the tail
 * the day a family scripts a beat past it, and a case that was asserting over the
 * whole script starts asserting over a prefix of it and still passes.
 */
export function lastScriptedBeatMs(scenario: Scenario): number {
  return scenario.beats.reduce((latest, beat) => Math.max(latest, beat.atMs), 0);
}

/** The real fixture bridge over a real scenario, and the real engine driving it. */
export function createFixture(
  scenario: Scenario = CONCURRENT_STREAMING_SCENARIO,
): FixtureUnderTest {
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
 * make, because `DaemonEvent` is a `never`-shaped stub and a tighter payload type
 * here would be a fiction.
 *
 * The delivered type is a PARAMETER because the answer depends on the name: the
 * whole-session stream and a bare event type deliver the canonical `EventEnvelope`,
 * and the two narrowed run streams deliver the registered projection. Defaulting it
 * to the envelope lets every caller on the unprojected arms assert through the
 * wire's own shape — `type`, not the console's `kind` — while the run-stream suite
 * names what it actually receives instead of asserting through a type that is wrong
 * for it.
 */
export function subscribeThroughBridge<Delivered = EventEnvelope>(
  fixture: FixtureUnderTest,
  eventName: string,
): readonly Delivered[] {
  const received: Delivered[] = [];
  fixture.bridge.daemon.subscribe(eventName as DaemonEvent, (payload: unknown) => {
    received.push(payload as Delivered);
  });
  return received;
}

/**
 * Reach one bridge's call door, whichever bridge that is.
 *
 * The raw call, written once. {@link callThroughBridge} is the fixture-shaped caller
 * and a suite holding a WRAPPED bridge — the answer arm below — has one too, so the
 * cast to the `DaemonMethod` brand lives here rather than at each of them.
 */
export function callBridge(
  bridge: PlatformBridge,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return bridge.daemon.call(method as DaemonMethod, params);
}

export function callThroughBridge(fixture: FixtureUnderTest, method: string): Promise<unknown> {
  return callBridge(fixture.bridge, method);
}

/**
 * Replace one bridge's `daemon.call` with an arm this suite decides the answer for.
 *
 * A spread over a REAL bridge, which is the console's established shape for driving
 * one namespace member (`palette/commands/bridge-commands.test.tsx`). That the rest is real is
 * the point: a surface reaches the wire through `bridge.daemon.call` and
 * nothing else, so a case passing against a hand-built object would not have proved
 * it reached a bridge at all.
 *
 * Takes the bridge rather than building one, so a suite that has already overridden a
 * different namespace composes the two instead of minting a second builder to hold
 * both.
 *
 * THE ANSWER IS HANDED THE WRAPPED BRIDGE'S OWN CALL, which is what lets a suite
 * decide ONE method and leave every other one scripted by the scenario. Without it a
 * suite that only cares about `session.read` has to answer for `driver.listModels` too, and
 * the only shape available is a hand-written stub — which is exactly what this helper
 * exists to keep out of a suite that means to reach a real bridge. Delegation lives
 * here once rather than being spelled at each site that needs it.
 */
export function withDaemonCall(
  bridge: PlatformBridge,
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
): BridgeUnderTest {
  const calls: RecordedDaemonCall[] = [];
  // Bound before the spread below, so the pass-through reaches the bridge this helper
  // WRAPPED rather than the arm it is building — which would call itself forever.
  const wrappedCall = bridge.daemon.call.bind(bridge.daemon) as (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  return {
    calls,
    bridge: {
      ...bridge,
      daemon: {
        ...bridge.daemon,
        call: (async (method: string, params: unknown): Promise<unknown> => {
          const recorded: RecordedDaemonCall = { method, params };
          calls.push(recorded);
          return answer(recorded, async () => wrappedCall(method, params));
        }) as PlatformBridge["daemon"]["call"],
      },
    },
  };
}

/**
 * Replace one bridge's `daemon.subscribe` with an arm this suite decides.
 *
 * {@link withDaemonCall}'s twin for the OTHER daemon seam, and here for the same
 * reason that one is: the namespace spread that composes it is a reach admitted inside
 * this family and nowhere else, so a surface suite that wrote it itself would be a
 * second door. Everything but the subscription stays the wrapped bridge's, so a
 * case proving a surface came back after a refused open really did drive a bridge.
 *
 * `open` receives the pass-through so a case can refuse the first attempt and hold
 * the next, which is the shape the shipped stub preload puts a console in: every
 * daemon method throws until a build with a real one is installed.
 */
export function withDaemonSubscribe(
  bridge: PlatformBridge,
  open: (passThrough: () => Unsubscribe) => Unsubscribe,
): PlatformBridge {
  // Bound before the spread, so the pass-through reaches the bridge this helper
  // WRAPPED rather than the arm it is building — which would call itself forever.
  const wrappedSubscribe = bridge.daemon.subscribe.bind(bridge.daemon) as (
    event: string,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  return {
    ...bridge,
    daemon: {
      ...bridge.daemon,
      subscribe: ((event: string, handler: (payload: unknown) => void): Unsubscribe =>
        open(() => wrappedSubscribe(event, handler))) as PlatformBridge["daemon"]["subscribe"],
    },
  };
}

/**
 * The shipped fixture with that call arm on it, over the concurrent-streaming scenario or over a
 * scenario the suite names.
 *
 * The parameter is optional so the common case reads as it did, and present because a
 * family suite drives its OWN scenario — the composer's, the approvals pane's — and
 * without it each one had to reach for `createFixtureBridge` and rebuild the spread.
 */
export function bridgeAnswering(
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
  scenario?: Scenario,
): BridgeUnderTest {
  return withDaemonCall(createFixture(scenario).bridge, answer);
}

/**
 * A scenario that scripts no reply and plays no beat.
 *
 * The fixture bridge REJECTS every `daemon.call` a scenario scripts no reply for,
 * which is the arm a surface's own refusal rendering has to survive — so "nothing
 * scripted" is a deliberate posture rather than an empty placeholder, and the four
 * settings tests that need one would otherwise each write this literal out.
 *
 * The id is the caller's because the fixture names it in the refusal it raises: a
 * shared id would put one test's scenario name in another test's rendered failure.
 */
export function unscriptedScenario(id: string): Scenario {
  return {
    id,
    label: "Nothing scripted",
    purpose: "Drives a surface against a bridge that scripts no reply and plays no beat.",
    sessionId: `session-${id}`,
    userIdsInJoinOrder: [],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T10:05:00.000Z",
  };
}

/**
 * A bridge over a scenario that scripts nothing, whose window runs on this clock.
 *
 * `resolveBridgeClock` reads the scenario engine's clock, and `FixtureBridgeOptions` takes no
 * clock, so the engine member is replaced by hand. The scenario id is the caller's for the
 * reason `unscriptedScenario` gives.
 */
export function bridgeOnClock(scenarioId: string, clock?: Clock): PlatformBridge {
  const bridge = createFixtureBridge({ scenario: unscriptedScenario(scenarioId) });
  if (clock === undefined) {
    return bridge;
  }
  return { ...bridge, scenarioEngine: { clock } } as PlatformBridge;
}
