// A scenario carrying only the members the vocabulary requires, for the suites in this
// directory that need one as INPUT.
//
// The runtime imports no scenario from the corpus above it — that is what lets the
// engine change without touching a family's fixture, and the corpus grow without
// touching the engine. A suite here that needs a scenario to drive therefore declares
// one, and declares it once: three of them do, and a fourth copy of these eight members
// would be a second answer to "what is the smallest scenario the runtime accepts".

import type { ConsoleScenario } from "./vocabulary.js";

/** The one instant every stand-in starts at, so two of them are ordered by nothing. */
const STAND_IN_STARTED_AT_ISO = "2026-01-14T11:20:00.000Z";

/** The session a stand-in names. One id, because no suite here reads two sessions. */
export const STAND_IN_SESSION_ID = "019b7a10-4c00-7d31-9f02-6b1a5e900001";

/**
 * A scenario with only the members the vocabulary requires, named by its caller.
 *
 * Every optional member is left absent rather than filled with a plausible value: a
 * suite that needs one states it by spreading, which is what keeps the thing it varies
 * legible beside seven members it does not.
 */
export function scenarioNamed(id: string): ConsoleScenario {
  return {
    id,
    label: id,
    purpose: "A scenario standing in for one on the board.",
    sessionId: STAND_IN_SESSION_ID,
    participantIdsInJoinOrder: [],
    startedAtIso: STAND_IN_STARTED_AT_ISO,
    beats: [],
    replies: [],
  };
}
