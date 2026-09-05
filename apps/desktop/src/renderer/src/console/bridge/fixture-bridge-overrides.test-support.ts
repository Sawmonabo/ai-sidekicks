// The real fixture bridge with named growth operations replaced — written once.
//
// Five co-located tests were each building the same thing by hand: a bridge whose
// growth port answers the one operation the surface under test reads, and answers it
// with either a served value or the port's own refusal. Two of them spread the real
// `createFixtureBridge` and three cast an object literal through
// `as unknown as ConsoleBridge`, which is worse than a duplicate — a cast bridge is
// shape-identical to nothing, so a namespace the console starts reading is a runtime
// `undefined is not a function` in the test rather than a compile error. This module
// is the one construction, and it is a real `ConsoleBridge` on every arm.
//
// WHY THE REFUSAL IS BUILT AND NOT WRITTEN DOWN. Three of those tests carried their
// own `CARRIER_UNAVAILABLE` literal — four fields, hand-typed, checked against
// nothing. `growthRefusing` calls the shipped `growthUnavailable`, so what a test
// asserts against is what a release build actually produces: the same code, the same
// origin, the same sentence composed from the operation's own slate row. A literal
// that drifted from the port would make a green test a claim about a value the
// console never emits.
//
// WHY THESE ARE FUNCTIONS AND NOT CONSTANTS. A module of constants that only test
// files import has no outgoing edges, which is precisely what the layering gate's
// `no-orphans` rule rejects — test files are excluded from that cruise, so its
// dependents are invisible and only its own imports keep it connected. Builders also
// buy the property a shared constant cannot have: each call mints a fresh bridge, so
// one test's engine is never another test's engine.
//
// WHY IT IS NOT IN THE FAMILY BARREL. `index.ts` is the door the CONSOLE reaches the
// bridge through, and nothing outside a test may reach this. The `.test-support.ts`
// suffix keeps it out of every Vitest project's `include` glob — those match
// `*.test.ts` exactly — so it is compiled and type-checked like source and collected
// as a suite by nobody.

import type { ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthServed, GrowthUnavailable } from "./growth-outcome.js";
import { growthUnavailable, type GrowthPort } from "./growth-port.js";
import type { ConsoleScenario } from "./scenario.js";

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
