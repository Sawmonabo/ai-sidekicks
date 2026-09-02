// The ledger scenario — the roster, and no beats yet.
//
// The flagship scenario next door is the four-lane session the whole console is
// measured against. This one is its opposite and exists for the case that one cannot
// show: a session that has been opened and has done nothing. Rule 8 says the five
// kinds of nothing render differently, and "empty" is the only one a scripted stream
// of events can never reach — so a scenario with a roster and an empty script is what
// makes the ledger's empty state reachable in the fixture picker at all.
//
// The roster is the load-bearing part, exactly as it is for the flagship: rule 2
// allocates participant hues by join-log order, so the order of
// `participantIdsInJoinOrder` is what the hue allocator consumes and what a
// screenshot baseline depends on. Two people and one agent, which is the smallest
// roster that still shows a wrapped-hue treatment apart from a first-step one.
//
// The beats stay empty here. The scripted first sixty seconds — the streaming lanes,
// the chapters, the seams, the reading anchor holding while rows land above it —
// belong to the lane that authors the ledger frame those beats are the input to, and
// a script written before the surface it drives is a script written against a guess.

import type { ConsoleScenario } from "../scenario.js";

export const LEDGER_SCENARIO_ID = "ledger";

const SESSION_ID = "session-ledger";

export const LEDGER_SCENARIO: ConsoleScenario = {
  id: LEDGER_SCENARIO_ID,
  label: "Quiet session",
  purpose:
    "A session with a roster and nothing on the log yet. Reaches the ledger's empty state, which no scripted stream can.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you", "participant-priya", "agent-implementer"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [],
  replies: [
    {
      call: "session.list",
      result: {
        sessions: [{ sessionId: SESSION_ID, title: "Nothing yet", state: "active" }],
      },
    },
  ],
};
