// The fixture's session read: the base state a store opens on. A `SessionStore` admits nothing
// until a read gives it a base state, so serving one from the scenario is what lets the whole
// store layer run against a scripted session. The base state is not `SessionReadResponse` from
// `@ai-sidekicks/contracts`: `SessionStore.initialize` takes the console's own `SessionBaseState`
// (`store/session/session-state.ts`) with a numeric `cursor` and `entities`, and the registered
// reply carries neither. `session-base-state.fixture.ts` derives the base state.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import type { WireErrorEnvelope } from "@renderer/lib/wire-errors.js";
import type { SessionBaseState } from "@renderer/store/session/session-state.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { fixtureSessionBaseState } from "./session-base-state.fixture.js";

/** The session read's request: the session, and the position the caller last acknowledged. */
export interface FixtureSessionReadRequest {
  readonly sessionId: string;
  readonly fromCursor?: string;
}

/**
 * The fixture's session answers for one running scenario.
 *
 * `sessionRead` serves the base state and, for a scenario that declares it, throws the one
 * refusal the resume cycle can receive, only on the arm that carries a position. That makes
 * recovery observable: the entry forgets the refused position, re-reads with none and records the
 * refusal. Refusing both arms would leave the store with no base state.
 */
export function fixtureSessionAnswers(engine: ScenarioEngine): {
  readonly sessionRead: (request: FixtureSessionReadRequest) => Promise<SessionBaseState>;
} {
  return {
    sessionRead: async (request) => {
      if (
        request.fromCursor !== undefined &&
        engine.scenario.refusesSubmittedResumeCursor === true
      ) {
        throw unresolvableResumeCursorRefusal();
      }
      return fixtureSessionBaseState(engine.scenario, request.sessionId);
    },
  };
}

/**
 * The daemon's refusal of a position it could not resolve, thrown as the wire's own envelope so
 * `isUnresolvableCursorRejection` (which reads the daemon's code) recognizes it. The message
 * names no cursor.
 */
function unresolvableResumeCursorRefusal(): WireErrorEnvelope {
  return {
    code: EVENT_CURSOR_UNRESOLVABLE_CODE,
    message: "the submitted cursor could not be resolved to a position in this log",
  };
}
