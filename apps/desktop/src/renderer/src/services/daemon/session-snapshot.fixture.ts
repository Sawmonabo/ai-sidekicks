// The base state the fixture's session read establishes.
//
// `session-answers.ts` serves it. This file derives what one session already CONTAINS at
// the moment a store opens on it.
//
// AND THAT MOMENT IS WHAT SCOPES IT. What a session contains LATER is a fold of the
// delivered log over this base state, and each plane that needs one owns its own fold.
// This file is every such fold's opening term and answers nothing about what has
// happened since.
//
// WHAT THE BASE STATE HONESTLY IS
//
// Cursor zero, no entities, and the scripted timeline cursors. Zero rather than a
// position derived from the scenario's beats, because a base state ahead of the stream
// would make the store discard every beat below it; the subscription is
// replay-then-tail, so nothing is missed by starting at the bottom. A re-read therefore
// lands behind an initialised store's cursor and is a silent no-op, which is
// `SessionStore.admitsSnapshotAt`'s documented behaviour and not a defect of this
// derivation: repairing a degraded store needs a read that carries a position, and this
// one cannot until the wire does.
//
// IT CARRIES NO ENTITIES, AND THAT IS A READING RATHER THAN A GAP. Every partition a
// surface reads is projected from the delivered log by a registered projector, so a
// base state that filed rows of its own would be a second source of truth for them.

import { scriptedSessionReadMember } from "./scripted-session-read.fixture.js";
import type { ConsoleScenario } from "@renderer/console/bridge/scenario/runtime/index.js";
import { BASE_STATE_CURSOR, type SessionSnapshot } from "@renderer/store/session/session-state.js";

/**
 * The base state one scenario establishes for one session.
 *
 * Scoped to the session the scenario is PLAYING: another id reads as an empty session
 * rather than as a refusal — the read IS answered, and what it found for that session
 * is nothing.
 */
export function fixtureSessionSnapshot(
  scenario: ConsoleScenario,
  sessionId: string,
): SessionSnapshot {
  if (sessionId !== scenario.sessionId) {
    return { cursor: BASE_STATE_CURSOR, entities: [] };
  }
  return {
    cursor: BASE_STATE_CURSOR,
    entities: [],
    // Carried UNREAD from the scenario's own reply, which is where a daemon puts it.
    // The store's resume rule owns the shape and the narrowing, so a scenario that
    // scripts no cursor block, or one that predates the floor member, reaches the
    // refusal arm here exactly as an older daemon would — which is the state this
    // fixture has to be able to reproduce rather than paper over.
    timelineCursors: scriptedSessionReadMember(scenario, "timelineCursors"),
  };
}
