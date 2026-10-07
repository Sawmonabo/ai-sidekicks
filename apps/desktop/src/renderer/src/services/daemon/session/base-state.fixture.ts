// The base state the fixture's session read establishes: what one session already contains when a
// store opens on it.
//
// It is cursor zero, no entities and the scripted transcript cursors. Zero rather than a position
// derived from the beats, because a base state ahead of the stream would make the store discard
// every beat below it; the subscription is catch up, then follow, so nothing is missed. There are
// no entities because every partition is projected from the delivered log.

import type { Scenario } from "#fixtures/scenario.js";
import { BASE_STATE_CURSOR, type SessionBaseState } from "#renderer/store/session/state.js";

/**
 * The base state one scenario establishes for one session. Another id reads as an empty session,
 * not a refusal: the read is answered and found nothing.
 */
export function fixtureSessionBaseState(scenario: Scenario, sessionId: string): SessionBaseState {
  if (sessionId !== scenario.sessionId) {
    return { cursor: BASE_STATE_CURSOR, entities: [] };
  }
  return { cursor: BASE_STATE_CURSOR, entities: [] };
}
