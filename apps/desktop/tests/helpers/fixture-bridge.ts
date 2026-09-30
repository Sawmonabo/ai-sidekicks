// What every fixture-bridge suite needs before it can ask the bridge anything: the fixture and
// its engine, the subscribe and call helpers, and bridges whose call or subscribe arm a suite
// decides. Roles only one suite uses stay beside it.

import type {
  DaemonEvent,
  DaemonMethod,
  DaemonParams,
  DaemonSubscribeParams,
  EventEnvelope,
  SessionStreamFrame,
} from "@ai-sidekicks/contracts";
import type { Unsubscribe } from "@shared/preload-api.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Clock } from "@renderer/lib/clock.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import type { Scenario } from "../../fixtures/scenario.js";
import type { ScenarioEngine } from "@renderer/services/daemon/engine.fixture.js";
import { SESSION_EVENT_STREAM } from "@renderer/services/daemon/session-event-streams.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";

/** The fixture bridge and the engine driving its scenario. */
export interface FixtureUnderTest {
  readonly bridge: PlatformBridge;
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
 * The tick a scenario's last beat falls due at, read off the script so a case asserting "past
 * every beat" keeps covering the tail when a scenario grows.
 */
export function lastScriptedBeatMs(scenario: Scenario): number {
  return scenario.beats.reduce((latest, beat) => Math.max(latest, beat.atMs), 0);
}

/** The real fixture bridge over a real scenario, and the real engine driving it. */
export function createFixture(
  scenario: Scenario = CONCURRENT_STREAMING_SCENARIO,
): FixtureUnderTest {
  const { bridge, scenarioEngine } = createFixtureBridge({ scenario });
  return { bridge, engine: scenarioEngine };
}

/**
 * Subscribe through the bridge as a view would, scoped to the scenario's session.
 *
 * The event name is cast to `DaemonEvent` and the payload left `unknown` because suites name
 * streams by string, including bare event types the daemon's method map omits. The delivered
 * type is a parameter because it depends on the name: a bare event type delivers
 * `EventEnvelope`, the whole-session stream delivers frames (read those through
 * {@link subscribeToSessionStream}), and the two narrowed run streams deliver the registered
 * projection.
 */
export function subscribeThroughBridge<Delivered = EventEnvelope>(
  fixture: FixtureUnderTest,
  eventName: string,
): readonly Delivered[] {
  const received: Delivered[] = [];
  const request = { sessionId: fixture.engine.scenario.sessionId };
  fixture.bridge.daemon.subscribe(
    eventName as DaemonEvent,
    request as DaemonSubscribeParams<DaemonEvent>,
    (payload: unknown) => {
      received.push(payload as Delivered);
    },
  );
  return received;
}

/** What a whole-session stream subscriber was handed: the frames, and their events in order. */
export interface SessionStreamReceipt {
  readonly frames: readonly SessionStreamFrame<EventEnvelope>[];
  /** Every change's event across the frames received so far, in delivery order. */
  events(): readonly EventEnvelope[];
}

/**
 * Subscribe to the whole-session stream through the bridge, as the session binder does.
 *
 * Frames are kept as delivered so a case can assert the framing; events are read off them on
 * demand so a case about which beats arrived asserts over the log, not over its batching.
 */
export function subscribeToSessionStream(fixture: FixtureUnderTest): SessionStreamReceipt {
  const frames = subscribeThroughBridge<SessionStreamFrame<EventEnvelope>>(
    fixture,
    SESSION_EVENT_STREAM,
  );
  return {
    frames,
    events: () => frames.flatMap((frame) => frame.changes.map((change) => change.event)),
  };
}

/**
 * Reach one bridge's call function, whichever bridge that is; the casts live here once. The
 * suites using it test the fixture's reply seam, which answers by method name, so a request that
 * does not match the method's contract, or none at all, is part of what they send.
 */
export function callBridge(
  bridge: PlatformBridge,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return bridge.daemon.call(method as DaemonMethod, params as DaemonParams<DaemonMethod>);
}

/** Call a method on the fixture's bridge with no params. */
export function callThroughBridge(fixture: FixtureUnderTest, method: string): Promise<unknown> {
  return callBridge(fixture.bridge, method);
}

/**
 * Replace one bridge's `daemon.call` with an arm this suite decides the answer for.
 *
 * It spreads over a real bridge, so a case still proves a view reaches the wire through
 * `bridge.daemon.call`. It takes the bridge so a suite that overrode another namespace composes
 * both. The answer is handed the wrapped bridge's own call, so a suite decides one method and
 * leaves the rest scripted by the scenario instead of hand-writing a stub for each.
 */
export function withDaemonCall(
  bridge: PlatformBridge,
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
): BridgeUnderTest {
  const calls: RecordedDaemonCall[] = [];
  // Bound before the spread so the pass-through reaches the wrapped bridge, not the new arm.
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
 * Replace one bridge's `daemon.subscribe` with an arm this suite decides; the twin of
 * {@link withDaemonCall}.
 *
 * `open` receives the pass-through, so a case can refuse the first attempt and hold the next,
 * plus the subscriber's handler and request, so it can deliver what no scenario plays, such as
 * a frame carrying the daemon's drop mark.
 */
export function withDaemonSubscribe(
  bridge: PlatformBridge,
  open: (
    passThrough: () => Unsubscribe,
    handler: (payload: unknown) => void,
    request: unknown,
  ) => Unsubscribe,
): PlatformBridge {
  // Bound before the spread so the pass-through reaches the wrapped bridge, not the new arm.
  const wrappedSubscribe = bridge.daemon.subscribe.bind(bridge.daemon) as (
    event: string,
    request: unknown,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  return {
    ...bridge,
    daemon: {
      ...bridge.daemon,
      subscribe: ((
        event: string,
        request: unknown,
        handler: (payload: unknown) => void,
      ): Unsubscribe =>
        open(
          () => wrappedSubscribe(event, request, handler),
          handler,
          request,
        )) as PlatformBridge["daemon"]["subscribe"],
    },
  };
}

/** A bridge whose call arm answers as the suite says, and the engine playing its scenario. */
export interface AnsweringBridge extends BridgeUnderTest {
  /** Its frozen clock is the one the window runs on. */
  readonly engine: ScenarioEngine;
}

/**
 * The shipped fixture with that call arm on it, over concurrent-streaming or a named scenario,
 * so a feature suite driving its own scenario need not rebuild the spread.
 */
export function bridgeAnswering(
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
  scenario?: Scenario,
): AnsweringBridge {
  const { bridge, engine } = createFixture(scenario);
  return { ...withDaemonCall(bridge, answer), engine };
}

/**
 * A scenario that scripts no reply and plays no beat. The fixture bridge rejects every
 * `daemon.call` with no scripted reply, which is the arm a view's refusal rendering must
 * survive. The id is the caller's because the fixture names it in the refusal it raises.
 */
export function unscriptedScenario(id: string): Scenario {
  return {
    id,
    label: "Nothing scripted",
    purpose: "Drives a view against a bridge that scripts no reply and plays no beat.",
    sessionId: `session-${id}`,
    userIdsInJoinOrder: [],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T10:05:00.000Z",
  };
}

/** A bridge over a scenario that scripts nothing, the engine playing it, and its window's clock. */
export interface BridgeOnClock {
  readonly bridge: PlatformBridge;
  readonly scenarioEngine: ScenarioEngine;
  /** The clock the window runs on: the one the case handed in, or the engine's frozen one. */
  readonly clock: Clock;
}

/**
 * A bridge over a scenario that scripts nothing, whose window runs on this clock. The clock is
 * handed to the provider beside the bridge, as a window resolves one.
 */
export function bridgeOnClock(scenarioId: string, clock?: Clock): BridgeOnClock {
  const { bridge, scenarioEngine } = createFixtureBridge({
    scenario: unscriptedScenario(scenarioId),
  });
  return { bridge, scenarioEngine, clock: clock ?? scenarioEngine.clock };
}
