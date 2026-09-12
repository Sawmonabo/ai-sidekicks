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
// WHY THE SNAPSHOT IS NOT `SessionReadResponse` FROM `@ai-sidekicks/contracts`
//
// That is the registered reply and it is the wrong shape for this seam. It carries
// `{ session, timelineCursors }` — a session's identity, state, config, metadata and
// timestamps beside a `latest` cursor — and `SessionStore.initialise` takes the
// console's own `SessionSnapshot` from `store/session/session-state.ts`: a numeric
// `cursor`, the `entities` the read carried, and the `userJoinLog` the hue
// wheel is allocated in. The reply carries neither of the last two at all, and its
// cursor is an opaque branded STRING whose internal structure the daemon owns and whose
// schema is `min(1)` — so nothing here can order on it. Adopting the registered shape
// would leave the adapter fabricating all three anyway.
//
// The brand is NOT part of that argument any more, and saying it was would be false
// of this tree: a scenario's session id is a UUID now — several are minted through
// `SessionIdSchema.parse` itself — rather than the scripted name it once was, so a
// schema-valid `SessionId` costs no cast. The port's value is
// the console's `SessionSnapshot` because of what the reply omits, and for no other
// reason; the slate row names the registered request and reply as the half the corpus
// already owns.
//
// WHAT THE BASE STATE HONESTLY IS — and why it is not derived here. Cursor zero and
// the session's own snapshot, all of it `session-snapshot.ts`'s, whose header carries
// the reasoning for each.
//
// WHY THE CALLER-IDENTITY READ IS ANSWERED FROM A FIELD AND NOT FROM JOIN ORDER
//
// `ConsoleScenario` carries `viewingUserId` — which of the roster this window
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
// viewer to the roster, so the served arm can never answer with an identity the store
// has never held: the roster arrives with the base state (`session-snapshot.ts`), so a
// surface that renders this identity beside the store's own rows finds it there.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import type { WireErrorEnvelope } from "../../../core/index.js";
import { directorySessionsOf } from "./session-directory.js";
import { fixtureSessionSnapshot } from "./session-snapshot.js";
import { growthUnavailable, type GrowthPort } from "../../growth-port/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

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
  "callerUserRead",
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
    // The base state, and — for a scenario that declares it — the one refusal the
    // console's resume cycle can actually receive.
    //
    // REFUSED ON THE ARM THAT CARRIES A POSITION AND SERVED ON THE ARM THAT DOES NOT,
    // which is what makes the console's recovery observable rather than merely
    // asserted: the entry forgets the refused position, re-reads the same session
    // through the same reader with none, and records the refusal for the surface. A
    // scenario that refused both arms would leave the store with no base state at all
    // and report an outage instead of a lost place.
    //
    // THROWN AS THE WIRE'S OWN ENVELOPE, unwrapped, on the rule
    // `../growth/scripted-answer.ts` states for its refused settlement: a scripted
    // refusal is the DAEMON's, and paraphrasing it into a growth-scoped code would
    // teach a surface a shape the live seam never sends — here specifically it would
    // put the refusal past `isUnresolvableCursorRejection`, which reads the daemon's
    // own code, and the recovery this arm exists to drive would never run.
    sessionRead: async (request) => {
      if (
        request.fromCursor !== undefined &&
        engine.scenario.refusesSubmittedResumeCursor === true
      ) {
        throw unresolvableResumeCursorRefusal();
      }
      return {
        status: "served",
        value: fixtureSessionSnapshot(engine.scenario, request.sessionId),
      };
    },
    sessionList: async () => ({
      status: "served",
      value: directorySessionsOf(engine.scenario),
    }),
    callerUserRead: async (request) => {
      const { viewingUserId } = engine.scenario;
      // Refused rather than answered with an absence, on the branch-context read's
      // reading: a scenario that has not said has left the question unasked rather
      // than answered it emptily, and a session always HAS a viewer, so there is no
      // "we asked and there is none" state to serve. Both take the "not checked"
      // refusal the live bridge takes.
      if (viewingUserId === undefined) {
        return growthUnavailable("callerUserRead");
      }
      // Scoped to the session the scenario is playing, on the `sessionRead` rule
      // above: an identity is a fact about one session's roster, and lending this
      // session's viewer to another would tell a surface it holds a role in a session
      // it may not even be a member of.
      if (request.sessionId !== engine.scenario.sessionId) {
        return growthUnavailable("callerUserRead");
      }
      return { status: "served", value: { userId: viewingUserId } };
    },
  };
}

/**
 * The daemon's refusal of a position it could not resolve.
 *
 * The code is imported from the module that declares it rather than spelled here:
 * `store/session/timeline-resume.ts` is the console's single home for the string, and
 * the entry's recovery arm recognises the refusal by comparing against that same
 * constant. A literal here would be a second spelling, and the two would only have to
 * disagree once for the refusal to reach the store as an ordinary read failure.
 *
 * The message NAMES NO CURSOR. It stands in for a sentence a daemon writes, and the
 * console renders what it is sent — but the value that was refused is the console's
 * own and repeating it back adds nothing a surface may show.
 */
function unresolvableResumeCursorRefusal(): WireErrorEnvelope {
  return {
    code: EVENT_CURSOR_UNRESOLVABLE_CODE,
    message: "the submitted cursor could not be resolved to a position in this log",
  };
}
