// A session that has been opened and has done nothing.
//
// The opposite of `ledger.ts` next door, and it exists for the one case that one
// cannot show: rule 8's five kinds of nothing render differently, and EMPTY — a log
// with no rows — is the only one a scripted stream of events can never reach,
// because every beat it plays puts a row on screen. Without a scenario whose script
// is empty, the ledger's empty state is unreachable in the fixture picker at all,
// and an empty state nobody can look at is an empty state nobody designed.
//
// The roster is the load-bearing part, exactly as it is next door: `Spec-023
// §Console Design (Meridian)` rule 2 allocates participant hues by join-log order,
// so two people and one agent is the smallest roster that still shows a wrapped-hue
// treatment apart from a first-step one.
//
// Its two replies are the two reads the frame performs on opening a session. They
// answer `session.read` and `agent.list` — the registered method names — rather
// than a `session.list` the method registry does not carry.

import type { ConsoleScenario } from "../scenario.js";

export const LEDGER_QUIET_SCENARIO_ID = "ledger-quiet";

const SESSION_ID = "019b793b-7b60-75e5-8520-ada11a5a45a5";
const PARTICIPANT_YOU = "019b793b-7b60-79a4-8130-cca0117a0440";
const PARTICIPANT_PRIYA = "019b793b-7b60-79a4-8140-cca0117a0450";
const AGENT_IMPLEMENTER = "019b793b-7b60-7a6e-8140-d1a4c1150104";
const STARTED_AT_ISO = "2026-01-01T09:00:00.000Z";

export const LEDGER_QUIET_SCENARIO: ConsoleScenario = {
  id: LEDGER_QUIET_SCENARIO_ID,
  label: "Quiet session",
  purpose:
    "A session with a roster and nothing on the log yet. Reaches the ledger's empty state, which no scripted stream can.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, PARTICIPANT_PRIYA, AGENT_IMPLEMENTER],
  // One person opened this session and nothing has happened in it, so which of the
  // roster this window is is not in doubt — which is why it is stated rather than
  // left for the caller-identity read to refuse.
  viewingParticipantId: PARTICIPANT_YOU,
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
        },
        timelineCursors: { latest: "ledger-quiet-cursor-0" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          {
            agentId: AGENT_IMPLEMENTER,
            name: "Implementer",
            driverName: "claude",
            modelId: "claude-sonnet-5",
            config: {},
            state: "ready",
            createdAt: STARTED_AT_ISO,
          },
        ],
      },
    },
  ],
};
