// The fixture's session read: the base state a store opens on.
//
// WHY THE READ IS SERVED. A `SessionStore` admits nothing until a read gives it a base
// state. With no read answering, every store this renderer opens buffers its stream and
// projects none of it, so the store layer is dormant and the endurance tier measures an
// idle console. Serving it here, from the scenario and under the fixture define, is what
// lets the whole store layer run against a scripted session.
//
// WHY THE SNAPSHOT IS NOT `SessionReadResponse` FROM `@ai-sidekicks/contracts`. That is
// the registered reply, and it is the wrong shape for this seam: it carries `{ session,
// timelineCursors }`, while `SessionStore.initialize` takes the console's own
// `SessionSnapshot` from `store/session/session-state.ts` (a numeric `cursor`, the
// `entities` the read carried). The reply
// carries neither, and its cursor is an opaque branded string nothing
// here can order on. `session-snapshot.ts` derives the base state and carries the
// reasoning for each member.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import type { WireErrorEnvelope } from "@renderer/lib/wire-errors.js";
import type { SessionSnapshot } from "@renderer/store/session/session-state.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { fixtureSessionSnapshot } from "./session-snapshot.fixture.js";

/** The session read's request: the session, and the position the caller last acknowledged. */
export interface FixtureSessionReadRequest {
  readonly sessionId: string;
  readonly fromCursor?: string;
}

/**
 * The fixture's session answers for one running scenario.
 *
 * `sessionRead` serves the base state, and, for a scenario that declares it, throws the
 * one refusal the console's resume cycle can receive. The refusal is on the arm that
 * carries a position and the base state is served on the arm that does not, which makes
 * the console's recovery observable: the entry forgets the refused position, re-reads
 * the same session with none, and records the refusal for the surface. A scenario that
 * refused both arms would leave the store with no base state at all.
 */
export function fixtureSessionAnswers(engine: ScenarioEngine): {
  readonly sessionRead: (request: FixtureSessionReadRequest) => Promise<SessionSnapshot>;
} {
  return {
    sessionRead: async (request) => {
      if (
        request.fromCursor !== undefined &&
        engine.scenario.refusesSubmittedResumeCursor === true
      ) {
        throw unresolvableResumeCursorRefusal();
      }
      return fixtureSessionSnapshot(engine.scenario, request.sessionId);
    },
  };
}

/**
 * The daemon's refusal of a position it could not resolve.
 *
 * Thrown as the wire's own envelope: a scripted refusal is the daemon's, and
 * paraphrasing it would put it past `isUnresolvableCursorRejection`, which reads the
 * daemon's own code, so the recovery this arm exists to drive would never run. The
 * message names no cursor: the refused value is the console's own.
 */
function unresolvableResumeCursorRefusal(): WireErrorEnvelope {
  return {
    code: EVENT_CURSOR_UNRESOLVABLE_CODE,
    message: "the submitted cursor could not be resolved to a position in this log",
  };
}
