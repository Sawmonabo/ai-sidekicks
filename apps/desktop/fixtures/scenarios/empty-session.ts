// A session that has been opened and has done nothing.
//
// The opposite of `transcript-states.ts` beside it, for the one case that one cannot
// show: an empty log is the only kind of nothing a scripted stream can never reach,
// because every beat it plays puts a row on screen. Without a scenario whose script is
// empty, the transcript's empty state is unreachable in the fixture picker.
//
// The roster is one person.
//
// ITS ONE REPLY IS THE FRAME'S READ: `session.read`, the registered method name rather
// than a `session.list` the method registry does not carry. A call this scenario does
// not answer is refused by name, and each view renders that refusal where it
// happened.
import type { Scenario } from "../scenario.js";

export const EMPTY_SESSION_SCENARIO_ID = "empty-session";

const SESSION_ID = "019b793b-7b60-75e5-8520-ada11a5a45a5";
const USER_YOU = "019b793b-7b60-79a4-8130-cca0117a0440";
const STARTED_AT_ISO = "2026-01-01T09:00:00.000Z";

export const EMPTY_SESSION_SCENARIO: Scenario = {
  id: EMPTY_SESSION_SCENARIO_ID,
  label: "Quiet session",
  purpose:
    "A session with a roster and nothing on the log yet. Reaches the transcript's empty state, which no scripted stream can.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: [USER_YOU],
  // One person opened this session and nothing has happened in it, so which of the
  // roster this window is is not in doubt — which is why it is stated rather than
  // left for the caller-identity read to refuse.
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
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: STARTED_AT_ISO,
          draft: "",
        },
        timelineCursors: { latest: "empty-session-cursor-0" },
      },
    },
  ],
};
