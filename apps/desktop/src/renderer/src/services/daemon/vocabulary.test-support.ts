// A scenario with only the members the vocabulary requires, for suites here that need one as
// input. The runtime imports no scenario from the corpus, so a suite declares its own, and only
// here, once.

import type { Scenario } from "../../../../../fixtures/scenario.js";

/** The one instant every stand-in starts at, so nothing orders two of them. */
const STAND_IN_STARTED_AT_ISO = "2026-01-14T11:20:00.000Z";

/** The session a stand-in names; no suite here reads two sessions. */
export const FIXTURE_SCENARIO_SESSION_ID = "019b7a10-4c00-7d31-9f02-6b1a5e900001";

/**
 * A scenario with only the required members, named by its caller. Optional members are left absent
 * so a suite that spreads one in shows what it varies.
 */
export function scenarioNamed(id: string): Scenario {
  return {
    id,
    label: id,
    purpose: "A scenario standing in for one on the board.",
    sessionId: FIXTURE_SCENARIO_SESSION_ID,
    userIdsInJoinOrder: [],
    startedAtIso: STAND_IN_STARTED_AT_ISO,
    beats: [],
    replies: [],
  };
}
