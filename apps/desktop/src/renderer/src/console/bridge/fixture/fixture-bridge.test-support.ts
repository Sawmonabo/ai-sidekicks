// What every fixture-bridge suite needs before it can ask the bridge anything.
//
// One home for the roles more than one of the sibling suites plays: the fixture and
// the engine driving it, the two ways a surface reaches that bridge — a subscription
// and a call — the bridge whose call arm a suite decides the answer for, and the same
// fixture with named growth operations replaced. It holds nothing a single suite
// uses: the scripts each concern re-writes, and the constants only one of them reads,
// stay beside their reader.
//
// The macrotask drain the settling cases wait on is deliberately NOT here. It is a
// timing helper rather than a fixture one, and two families below `bridge/` wait on
// it, so it lives at `core/macrotask-boundary.test-support.ts` — the lowest family all
// three of its readers may reach.

import type {
  DaemonEvent,
  DaemonMethod,
  EventEnvelope,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../console-bridge.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import type { GrowthServed, GrowthUnavailable } from "../growth-port/growth-outcome.js";
import { growthUnavailable, type GrowthPort } from "../growth-port/growth-port.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario-runtime/index.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";

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
  fixture.bridge.sidekicks.daemon.subscribe(eventName as DaemonEvent, (payload: unknown) => {
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
  bridge: ConsoleBridge,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return bridge.sidekicks.daemon.call(method as DaemonMethod, params);
}

export function callThroughBridge(fixture: FixtureUnderTest, method: string): Promise<unknown> {
  return callBridge(fixture.bridge, method);
}

/** What the daemon was asked, so a case can assert it was never asked at all. */
export interface RecordedDaemonCall {
  readonly method: string;
  readonly params: unknown;
}

/** A bridge whose call arm answers as the suite says, and the record of what it was asked. */
export interface BridgeUnderTest {
  readonly bridge: ConsoleBridge;
  readonly calls: readonly RecordedDaemonCall[];
}

/**
 * Replace one bridge's `daemon.call` with an arm this suite decides the answer for.
 *
 * A spread over a REAL bridge, which is the console's established shape for driving
 * one namespace member (`palette/bridge-commands.test.tsx`). That the rest is real is
 * the point: a surface reaches the wire through `bridge.sidekicks.daemon.call` and
 * nothing else, so a case passing against a hand-built object would not have proved
 * it reached a bridge at all.
 *
 * Takes the bridge rather than building one, so a suite that has already overridden a
 * different namespace — a growth port answering its own operation, say — composes the
 * two instead of minting a second builder to hold both.
 *
 * THE ANSWER IS HANDED THE WRAPPED BRIDGE'S OWN CALL, which is what lets a suite
 * decide ONE method and leave every other one scripted by the scenario. Without it a
 * suite that only cares about `agent.list` has to answer for `presence.read` too, and
 * the only shape available is a hand-written stub — which is exactly what this helper
 * exists to keep out of a suite that means to reach a real bridge. Delegation lives
 * here once rather than being spelled at each site that needs it.
 */
export function withDaemonCall(
  bridge: ConsoleBridge,
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
): BridgeUnderTest {
  const calls: RecordedDaemonCall[] = [];
  // Bound before the spread below, so the pass-through reaches the bridge this helper
  // WRAPPED rather than the arm it is building — which would call itself forever.
  const wrappedCall = bridge.sidekicks.daemon.call.bind(bridge.sidekicks.daemon) as (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  return {
    calls,
    bridge: {
      ...bridge,
      sidekicks: {
        ...bridge.sidekicks,
        daemon: {
          ...bridge.sidekicks.daemon,
          call: (async (method: string, params: unknown): Promise<unknown> => {
            const recorded: RecordedDaemonCall = { method, params };
            calls.push(recorded);
            return answer(recorded, async () => wrappedCall(method, params));
          }) as ConsoleBridge["sidekicks"]["daemon"]["call"],
        },
      },
    },
  };
}

/**
 * Replace one bridge's `daemon.subscribe` with an arm this suite decides.
 *
 * {@link withDaemonCall}'s twin for the OTHER daemon seam, and here for the same
 * reason that one is: the namespace spread that composes it is a reach
 * `test/console/architecture/daemon-reply-chokepoint.test.ts` admits inside this
 * family and nowhere else, so a surface suite that wrote it itself would be a second
 * door. Everything but the subscription stays the wrapped bridge's, so a case
 * proving a surface came back after a refused open really did drive a bridge.
 *
 * `open` receives the pass-through so a case can refuse the first attempt and hold
 * the next, which is the shape the shipped Tier-1 preload puts a console in: every
 * daemon method throws until a build with a real one is installed.
 */
export function withDaemonSubscribe(
  bridge: ConsoleBridge,
  open: (passThrough: () => Unsubscribe) => Unsubscribe,
): ConsoleBridge {
  // Bound before the spread, so the pass-through reaches the bridge this helper
  // WRAPPED rather than the arm it is building — which would call itself forever.
  const wrappedSubscribe = bridge.sidekicks.daemon.subscribe.bind(bridge.sidekicks.daemon) as (
    event: string,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  return {
    ...bridge,
    sidekicks: {
      ...bridge.sidekicks,
      daemon: {
        ...bridge.sidekicks.daemon,
        subscribe: ((event: string, handler: (payload: unknown) => void): Unsubscribe =>
          open(() =>
            wrappedSubscribe(event, handler),
          )) as ConsoleBridge["sidekicks"]["daemon"]["subscribe"],
      },
    },
  };
}

/** The shipped fixture over the flagship scenario, with that call arm on it. */
export function bridgeAnswering(
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
): BridgeUnderTest {
  return withDaemonCall(createFixture().bridge, answer);
}

/* ---------------------------------------------------------------------------
 * The same fixture with named growth operations replaced.
 *
 * Folded in from a second support module rather than kept beside it: both files
 * answered one question — how a suite gets a real `ConsoleBridge` it can steer — and
 * a reader had to know which of the two held the arm they wanted. What follows is
 * the growth half of that answer.
 *
 * WHY THE REFUSAL IS BUILT AND NOT WRITTEN DOWN. Three suites once carried their own
 * `CARRIER_UNAVAILABLE` literal — four fields, hand-typed, checked against nothing.
 * `growthRefusing` calls the shipped `growthUnavailable`, so what a test asserts
 * against is what a release build actually produces: the same code, the same origin,
 * the same sentence composed from the operation's own slate row. A literal that
 * drifted from the port would make a green test a claim about a value the console
 * never emits.
 *
 * WHY THESE ARE FUNCTIONS AND NOT CONSTANTS. Each call mints a fresh bridge, so one
 * test's engine is never another test's engine — a property a shared constant cannot
 * have.
 * ------------------------------------------------------------------------- */

/**
 * The real fixture bridge for one scenario, with the named growth operations
 * replaced.
 *
 * `Partial<GrowthPort>` rather than a per-operation parameter: a caller replaces the
 * operations its surface reads and inherits the fixture's answer for every other one,
 * and the compiler holds each replacement to that operation's own request and value
 * types. Every other namespace — `sidekicks`, `growthServedOperations`, the scenario
 * engine — is the fixture's untouched, so a surface that starts reading one finds the
 * shipped answer rather than a hole.
 *
 * `growthServedOperations` is deliberately NOT recomputed from the overrides. It is
 * the FIXTURE's declaration of what it serves, read by composition roots that must
 * decide before a call can be awaited, and a test that quietly widened it would be
 * asserting against a bridge no window ever builds.
 */
export function fixtureBridgeWithGrowth(
  scenario: ConsoleScenario,
  overrides: Partial<GrowthPort>,
): ConsoleBridge {
  const fixture = createFixtureBridge({ scenario });
  return { ...fixture, growth: { ...fixture.growth, ...overrides } };
}

/**
 * An operation that answers with this value.
 *
 * The request is accepted and ignored — typed `unknown` so the builder fits every
 * operation's own request shape, and so a caller that wraps it in `vi.fn` can still
 * assert what the surface asked for.
 */
export function growthServing<TValue>(
  value: TValue,
): (request: unknown) => Promise<GrowthServed<TValue>> {
  return async () => await Promise.resolve({ status: "served", value });
}

/**
 * An operation that answers with whatever a scripted daemon hands back for it.
 *
 * `growthServing`'s lazy sibling: that one closes over a value decided before the
 * surface asked, and a suite holding a call OPEN — the shape every double-press case
 * needs — has to decide the answer at the moment of the call instead. The value is
 * cast because the answer is the SUITE's claim about that operation's shape, exactly
 * as a scripted `daemon.call` reply is: the growth port stands in for a wire the
 * corpus has not registered, so there is nothing to parse it against.
 */
export function growthAnswering<TValue>(
  answer: (request: unknown) => Promise<unknown>,
): (request: unknown) => Promise<GrowthServed<TValue>> {
  return async (request) => ({ status: "served", value: (await answer(request)) as TValue });
}

/**
 * An operation that answers with the shipped port's own refusal for it.
 *
 * The operation id is the refusal's subject as well as the method's name, which is
 * why it is a parameter rather than inferred: `growthUnavailable` composes the
 * sentence from that operation's slate row, so passing the wrong id would produce a
 * refusal naming a wire the surface never asked for.
 */
export function growthRefusing(
  operationId: GrowthOperationId,
): (request: unknown) => Promise<GrowthUnavailable> {
  return async () => await Promise.resolve(growthUnavailable(operationId));
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
export function unscriptedScenario(id: string): ConsoleScenario {
  return {
    id,
    label: "Nothing scripted",
    purpose: "Drives a surface against a bridge that scripts no reply and plays no beat.",
    sessionId: `session-${id}`,
    participantIdsInJoinOrder: [],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T10:05:00.000Z",
  };
}
