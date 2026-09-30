// A session that has been opened and has done nothing: one person and an empty log.
//
// Every beat a script plays puts a row on screen, so only a scenario with no beats reaches
// the transcript's empty state. Its one reply is `session.read`; a call it does not answer is
// refused by name and each view renders that refusal where it happened.

import type { Scenario } from "../scenario.js";

/** The id of the empty-session scenario. */
export const EMPTY_SESSION_SCENARIO_ID = "empty-session";

const SESSION_ID = "019b793b-7b60-75e5-8520-ada11a5a45a5";
const USER_YOU = "019b793b-7b60-79a4-8130-cca0117a0440";
const STARTED_AT_ISO = "2026-01-01T09:00:00.000Z";

/** A session with a roster and nothing on the log yet. */
export const EMPTY_SESSION_SCENARIO: Scenario = {
  id: EMPTY_SESSION_SCENARIO_ID,
  label: "Quiet session",
  purpose:
    "A session with a roster and nothing on the log yet. Reaches the transcript's empty state, which no scripted stream can.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: [USER_YOU],
  // One person is in the roster, so which of them this window is is not in doubt.
  callerUserId: USER_YOU,
  startedAtIso: STARTED_AT_ISO,
  beats: [],
  replies: [
    {
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          createdAt: STARTED_AT_ISO,
          updatedAt: STARTED_AT_ISO,
          draft: "",
        },
        timelineCursors: { latest: "empty-session-cursor-0" },
      },
    },
  ],
};
