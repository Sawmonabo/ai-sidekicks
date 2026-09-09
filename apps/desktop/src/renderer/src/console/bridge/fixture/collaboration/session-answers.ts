// The fixture's session answers: the base state, the node's directory, and the viewer.
//
// A MODULE OF ITS OWN RATHER THAN A BLOCK IN THE PORT, on `shell/shell-answers.ts`'
// rule. All three read the SAME two facts a scenario states about the session it is
// playing — its roster and which of that roster this window is — and each fails the
// same way when the scenario has not said, so the plane and the reasoning that admits
// it stay one unit.
//
// WHY THE TWO SESSION READS ARE SERVED AND THE REST ARE NOT
//
// A `SessionStore` admits nothing until a read gives it a base state. With no read
// registered anywhere, every store this renderer opens buffers its stream and
// projects none of it — so the window binds no stream at all, the store layer is
// dormant in every build, and the endurance tier measures an idle console. The
// directory read is the same shape one level up: without it the only session set a
// surface can name is the set this window happens to have open, so a fresh window
// shows "nothing" for a node with sessions on it.
//
// Serving them here — from the scenario, under the fixture define — is what lets
// the whole store layer run against a scripted session while the wire is still
// unregistered. The live bridge keeps refusing both, so nothing about what a
// release build renders changes.
//
// WHAT THE BASE STATE HONESTLY IS — and why it is not derived here. Cursor zero,
// the session's roster, and the memberships that roster holds, all of it
// `session-snapshot.ts`'s, whose header carries the reasoning for each.
//
// WHY THE CALLER-IDENTITY READ IS ANSWERED FROM A FIELD AND NOT FROM JOIN ORDER
//
// `ConsoleScenario` carries `viewingParticipantId` — which of the roster this window
// IS — and the read is served from that field and from nothing else. The field exists
// because the fact had no other honest source: join order is who opened the session
// and who followed, on any machine, so reading its head as "me" is a fabrication, and
// a surface handed a fabricated identity renders a role gate as though it had been
// checked.
//
// A scenario that states no viewer is therefore not a gap to fill in with a guess.
// The operation refuses for it and the refusal says "not checked" — which is true of
// a script that has not said. That is why the served set names this operation and the
// answer is still conditional: the operation IS scripted here, and whether a given
// scenario scripts the fact is the scenario's business. `wire-truth.ts` holds a stated
// viewer to the roster, so the served arm can never answer with an identity no surface
// could resolve a role from.
//
// AND THE ANSWER IS RESOLVABLE, WHICH IT WAS NOT. Being in the roster made the
// identity well-formed and left it unusable: the base state carried no entities and
// the composition root registers no `membership.*` projector, so `membershipRoleOf`
// found nothing for the viewer under any scenario and every owner- and
// collaborator-gated control rendered closed against a store that had never held a
// participant — which looks, on screen, exactly like a member with no elevated role.
// The roster now arrives with the base state (`session-snapshot.ts`), so the identity
// this read serves resolves to the role the scenario declares for it.

import { directorySessionsOf } from "./session-directory.js";
import { fixtureSessionSnapshot } from "./session-snapshot.js";
import { growthUnavailable, type GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario-runtime/index.js";

/**
 * The three session operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` in
 * `call-plane/served-operations.ts`, on
 * `FIXTURE_SERVED_SHELL_OPERATION_IDS`' rule: the ids and the implementations below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a read landed in only one of them.
 */
export const FIXTURE_SERVED_SESSION_OPERATION_IDS = [
  "sessionRead",
  "sessionList",
  "callerParticipantRead",
] as const;

/** One session operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedSessionOperationId = (typeof FIXTURE_SERVED_SESSION_OPERATION_IDS)[number];

/**
 * The fixture's three session answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureShellAnswers`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 */
export function fixtureSessionAnswers(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedSessionOperationId> {
  return {
    sessionRead: async (request) => ({
      status: "served",
      value: fixtureSessionSnapshot(engine.scenario, request.sessionId),
    }),
    sessionList: async () => ({
      status: "served",
      value: directorySessionsOf(engine.scenario),
    }),
    callerParticipantRead: async (request) => {
      const { viewingParticipantId } = engine.scenario;
      // Refused rather than answered with an absence, on the branch-context read's
      // reading: a scenario that has not said has left the question unasked rather
      // than answered it emptily, and a session always HAS a viewer, so there is no
      // "we asked and there is none" state to serve. Both take the "not checked"
      // refusal the live bridge takes.
      if (viewingParticipantId === undefined) {
        return growthUnavailable("callerParticipantRead");
      }
      // Scoped to the session the scenario is playing, on the `sessionRead` rule
      // above: an identity is a fact about one session's roster, and lending this
      // session's viewer to another would tell a surface it holds a role in a session
      // it may not even be a member of.
      if (request.sessionId !== engine.scenario.sessionId) {
        return growthUnavailable("callerParticipantRead");
      }
      return { status: "served", value: { participantId: viewingParticipantId } };
    },
  };
}
