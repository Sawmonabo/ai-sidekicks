// The first-run scenario: a console with nothing in it yet.
//
// A fresh install has no sessions, and "no sessions yet" is the empty kind of nothing: a
// stated fact with a next action, not "not loaded" and not an error.
//
// It scripts one beat and the reply the frame's opening read needs; every other call is
// refused by name and the frame renders the refusal.
//
// `tests/helpers/scenario-contract-check/contract-check.ts` holds the beat and replies to the
// wire contract: ids are UUIDs, and `session.created` carries the session's shape and its
// lead, not a title, which its `.strict()` schema rejects.

import { composeSessionCreatedPayload } from "../data/opening-entries.js";
import type { Scenario } from "../scenario.js";

/** The id of the first-run scenario. */
export const FIRST_RUN_SCENARIO_ID = "first-run";

const SESSION_ID = "019b78c9-0a80-75e5-8510-ada11a5a22a5";
const USER_YOU = "019b78c9-0a80-79a4-8110-cca0117a0220";
const AGENT_LEAD = "019b78c9-0a80-7a6e-8110-d1a4c1150201";
const STARTED_AT_ISO = "2026-01-01T09:00:00.000Z";

/** A freshly installed console: one user, one session being provisioned, no history. */
export const FIRST_RUN_SCENARIO: Scenario = {
  id: FIRST_RUN_SCENARIO_ID,
  label: "First run",
  purpose:
    "A freshly installed console with no sessions, no agents, and no history — the state the empty-state design and the screenshot baseline are pinned against.",
  sessionId: SESSION_ID,
  thisDeviceId: USER_YOU,
  // A fresh install has exactly one user, and this window is them.
  startedAtIso: STARTED_AT_ISO,
  beats: [
    {
      atMs: 0,
      event: {
        // The daemon's opaque row id, a UUID v7 like every other id here.
        id: "019b78c9-0a80-7ea1-8110-e5e0d1150001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: STARTED_AT_ISO,
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
    },
  ],
  replies: [
    {
      // `provisioning` is what a session being created reads as before it is admitted.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "provisioning",
          createdAt: "2026-01-01T09:00:00.000Z",
          updatedAt: "2026-01-01T09:00:00.000Z",
          draft: "",
        },
        timelineCursors: { latest: "first-run-cursor-1" },
      },
    },
  ],
};
