// The fixture's presence answers: who is composing where, and which host this node is on.
//
// A MODULE OF ITS OWN RATHER THAN A BLOCK IN THE PORT, on `shell-answers.ts`' rule.
// Both operations answer a fact the SCENARIO states about the node this fixture stands
// for rather than about a session's contents, and both refuse — never invent — where
// it has stated none, so the pair and the reasoning that admits them stay one unit.
//
// WHY THE ACTIVITY READ IS SERVED, AND WHY THE COMPOSER'S TWO WRITES ARE NOT
//
// The read is served so a scenario that states who is composing where can drive the
// indicators at all: every one of them rendered permanently empty while the operation
// refused, which is a surface whose only reachable state is its absence. Its
// unscripted arm REFUSES rather than serving two empty lists, on the runtime-node
// roster's rule — a scenario that has not said has left the question unasked, and
// "nobody is composing" is a claim about the room that nothing checked.
//
// The composer's `presenceComposingSet` / `presenceComposingClear` are writes with no
// empty state and no receipt, and there is a second reason beside that one: what a
// publish PRODUCES is somebody else's reading, so the fixture serving them would have
// to write into the very snapshot the read above answers from — a fixture publishing
// to itself, which would show this window its own indicator, something no real
// Awareness client ever does. They refuse, and the emitter's own fail-closed rule
// (it stops after a refusal) is exercised by that refusal rather than around it.
//
// WHY THE CONTROL-PLANE HOST READ IS SERVED FROM THE SCENARIO AND FROM NOWHERE ELSE
//
// A minted invitation is only sendable as a link, and the link is composed from this
// host — so leaving the read refusing left the one-time reveal permanently unable to
// show what a person would actually paste, which is the whole act. It is served from
// a scenario member the author writes down, exactly as the caller-identity read is,
// and refused by a scenario that names none. What it may never do is INVENT one: a
// plausible hostname nobody declared would put a copyable link in front of a person
// that opens nothing, and that is worse than the sentence saying the host has not
// been read. A scenario declaring one is not that — it is a fixture stating a fact
// about the node it stands for, like every other fact in it.

import { readActivityFromScenario } from "../growth/activity.js";
import { growthUnscriptedReply, type GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario-runtime/index.js";

/**
 * The two presence operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, on
 * `FIXTURE_SERVED_SHELL_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a read landed in only one of them.
 */
export const FIXTURE_SERVED_PRESENCE_OPERATION_IDS = [
  "presenceActivityRead",
  "controlPlaneHostRead",
] as const;

/** One presence operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedPresenceOperationId =
  (typeof FIXTURE_SERVED_PRESENCE_OPERATION_IDS)[number];

/**
 * The fixture's two presence answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureShellAnswers`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixturePresenceAnswers(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedPresenceOperationId> {
  return {
    // The session's live activity, resolved by the frame that has fallen due on the
    // frozen clock. Not routed through the scripted-reply seam, for the runtime-node
    // roster's reason: this answer is a function of the CLOCK, and the reply table
    // answers each call with one fixed value.
    presenceActivityRead: async (request) => readActivityFromScenario(engine, request),
    // The node's control-plane host, from the scenario's own declaration. Refused as
    // the SCENARIO's gap where none is declared — this fixture serves the operation,
    // so naming an unbuilt wire would send a reader to a document owing something
    // that already has a stand-in — and never answered with a host this fixture
    // chose, which would compose a link that opens nothing and looks exactly like
    // one that works.
    controlPlaneHostRead: async () => {
      const { controlPlaneHost } = engine.scenario;
      if (controlPlaneHost === undefined) {
        return growthUnscriptedReply("controlPlaneHostRead", "this node's control-plane host");
      }
      return { status: "served", value: { host: controlPlaneHost } };
    },
  };
}
