// The first-run scenario: a console with nothing in it yet.
//
// This is the scenario the screenshot baseline pins, because the emptiest state is
// the one most likely to look unfinished and the product bar is that it does not.
// `Spec-023 §Console Design (Meridian)` §The five kinds of nothing is the whole
// design problem here: a fresh install has no sessions, and "no sessions yet" is
// the EMPTY kind — a stated fact with a next action — not the "not loaded" kind and
// not an error.
//
// It scripts exactly one beat, the session the participant is about to create not
// existing yet, and the replies the frame's opening reads need. Everything else the
// first-run frame shows comes from the growth port refusing, which is the honest
// rendering of a console whose onboarding wire is not registered.

import type { ConsoleScenario } from "../scenario.js";

export const FIRST_RUN_SCENARIO_ID = "first-run";

export const FIRST_RUN_SCENARIO: ConsoleScenario = {
  id: FIRST_RUN_SCENARIO_ID,
  label: "First run",
  purpose:
    "A freshly installed console with no sessions, no agents, and no history — the state the empty-state design and the screenshot baseline are pinned against.",
  sessionId: "session-first-run",
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: "session-first-run",
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T09:00:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Untitled session" },
      },
    },
  ],
  replies: [
    { call: "session.list", result: { sessions: [] } },
    { call: "agent.list", result: { agents: [] } },
  ],
};
