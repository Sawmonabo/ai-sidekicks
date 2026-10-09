// The first-run scenario: an app with nothing in it yet.
//
// A fresh install has one session being provisioned and no history; "no history yet" is the
// empty kind of nothing: a stated fact with a next action, not "not loaded" and not an error.
//
// It scripts one beat and the reply the frame's opening read needs; every other call is
// refused by name and the frame renders the refusal.
//
// `tests/helpers/scenario/contract-check/all-axes.ts` holds the beat and replies to the
// wire contract: ids are UUIDs, and `session.created` carries the session's shape and its
// lead, not a title, which its `.strict()` schema rejects.

import {
  encodeEventCursor,
  START_OF_LOG_POSITION,
} from "@ai-sidekicks/contracts/session/event-cursor";

import { composeSessionCreatedPayload } from "../data/opening-entries.js";
import {
  composeScenarioInstant,
  composeScriptBeats,
  findBeatCursor,
} from "../data/script-entries.js";
import type { Scenario } from "../scenario.js";

/** The id of the first-run scenario. */
export const FIRST_RUN_SCENARIO_ID = "first-run";

const SESSION_ID = "019b78c9-0a80-75e5-8510-ada11a5a22a5";
const USER_YOU = "019b78c9-0a80-79a4-8110-cca0117a0220";
const AGENT_LEAD = "019b78c9-0a80-7a6e-8110-d1a4c1150201";
const STARTED_AT_MS: number = Date.UTC(2026, 0, 1, 9, 0);
const STARTED_AT_ISO: string = composeScenarioInstant(STARTED_AT_MS, 0);

const FIRST_RUN_BEATS = composeScriptBeats({
  sessionId: SESSION_ID,
  // The daemon's opaque row id, a UUID v7 like every other id here.
  eventIdStem: "019b78c9-0a80-7ea1-8110-e5e0d115",
  startedAtMs: STARTED_AT_MS,
  entries: [
    {
      atMs: 0,
      kind: "session.created",
      actorId: USER_YOU,
      payload: composeSessionCreatedPayload({
        sessionId: SESSION_ID,
        shape: "chat",
        openedBy: USER_YOU,
        lead: {
          agentId: AGENT_LEAD,
          name: "Lead",
          driverName: "claude",
          modelId: "claude-sonnet-5",
        },
        createdAt: STARTED_AT_ISO,
      }),
    },
  ],
});

/** A freshly installed app: one user, one session being provisioned, no history. */
export const FIRST_RUN_SCENARIO: Scenario = {
  id: FIRST_RUN_SCENARIO_ID,
  label: "First run",
  purpose:
    "A freshly installed app with one session being provisioned and no history: " +
    "the transcript's and the session list's empty state.",
  sessionId: SESSION_ID,
  startedAtIso: STARTED_AT_ISO,
  beats: FIRST_RUN_BEATS,
  replies: [
    {
      // `provisioning` is what a session being created reads as before it is admitted.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "provisioning",
          shape: "chat",
          muted: false,
          createdAt: STARTED_AT_ISO,
          updatedAt: STARTED_AT_ISO,
          draft: "",
          tags: [],
        },
        transcriptCursors: {
          earliest: encodeEventCursor(START_OF_LOG_POSITION),
          latest: findBeatCursor(FIRST_RUN_BEATS, FIRST_RUN_BEATS.length - 1),
        },
      },
    },
  ],
};
