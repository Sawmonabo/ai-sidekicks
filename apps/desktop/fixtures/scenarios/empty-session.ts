// A session that has been opened and has done nothing: an empty log.
//
// Every beat a script plays puts a row on screen, so only a scenario with no beats reaches
// the transcript's empty state. Its one reply is `session.read`; a call it does not answer is
// refused by name and each view renders that refusal where it happened.

import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
} from "@ai-sidekicks/contracts/session/event-cursor";

import type { Scenario } from "../scenario.js";

/** The id of the empty-session scenario. */
export const EMPTY_SESSION_SCENARIO_ID = "empty-session";

const SESSION_ID = "019b793b-7b60-75e5-8520-ada11a5a45a5";
const STARTED_AT_ISO = "2026-01-01T09:00:00.000Z";

/** A session with agents and nothing on the log yet. */
export const EMPTY_SESSION_SCENARIO: Scenario = {
  id: EMPTY_SESSION_SCENARIO_ID,
  label: "Quiet session",
  purpose:
    "A session with agents and nothing on the log yet. Reaches " +
    "the transcript's empty state, which no scripted stream can.",
  sessionId: SESSION_ID,
  startedAtIso: STARTED_AT_ISO,
  beats: [],
  replies: [
    {
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          shape: "chat",
          muted: false,
          pendingWorkingFolder: null,
          createdAt: STARTED_AT_ISO,
          updatedAt: STARTED_AT_ISO,
          draft: "",
          tags: [],
        },
        transcriptCursors: {
          earliest: encodeEventCursor(START_OF_LOG_POSITION),
          latest: encodeEventCursor(START_OF_LOG_POSITION),
        },
        // The record a read before any beat lands holds: no run has begun.
        liveRuns: [],
        standingEvents: [],
      },
    },
  ],
};
