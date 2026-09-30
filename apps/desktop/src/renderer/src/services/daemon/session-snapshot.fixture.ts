// The base state the fixture's session read establishes: what one session already contains when a
// store opens on it. `session-answers.fixture.ts` serves it.
//
// It is cursor zero, no entities and the scripted timeline cursors. Zero rather than a position
// derived from the beats, because a base state ahead of the stream would make the store discard
// every beat below it; the subscription is replay-then-tail, so nothing is missed. A re-read
// therefore lands behind an initialized store's cursor and is a silent no-op (`admitsSnapshotAt`),
// so repairing a degraded store needs a read that carries a position, which the wire does not yet.
// There are no entities because every partition is projected from the delivered log.

import { scriptedSessionReadMember } from "./scripted-session-read.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { BASE_STATE_CURSOR, type SessionSnapshot } from "@renderer/store/session/session-state.js";

/**
 * The base state one scenario establishes for one session. Another id reads as an empty session,
 * not a refusal: the read is answered and found nothing.
 */
export function fixtureSessionSnapshot(scenario: Scenario, sessionId: string): SessionSnapshot {
  if (sessionId !== scenario.sessionId) {
    return { cursor: BASE_STATE_CURSOR, entities: [] };
  }
  return {
    cursor: BASE_STATE_CURSOR,
    entities: [],
    // Carried unread from the scenario's reply, as a daemon does; the store narrows it. A scenario
    // that scripts no cursor block reaches the refusal arm, as an older daemon would.
    timelineCursors: scriptedSessionReadMember(scenario, "timelineCursors"),
  };
}
