// The settings scenario — skeleton.
//
// The settings surface is the one destination whose content is almost entirely NOT
// session state: it reads node health, shell preferences, provider accounts, and
// server governance, and every one of those wires is unregistered today. So this
// scenario scripts almost nothing on purpose. Its job is to put the console in a
// state where the settings rail is reachable and every page below it is answering
// from the growth port's refusal rather than from scripted data — which is exactly
// what the shipped build does, and therefore the state the pages must be designed
// against.
//
// A scenario that filled those pages with plausible-looking rows would make the
// fixture disagree with the application in the one direction that matters: the
// screenshots would show a working settings surface that nobody can reach.

import type { ConsoleScenario } from "../scenario.js";

export const SETTINGS_SCENARIO_ID = "settings";

const SESSION_ID = "session-settings";

export const SETTINGS_SCENARIO: ConsoleScenario = {
  id: SETTINGS_SCENARIO_ID,
  label: "Settings, nothing asked",
  purpose:
    "One quiet session so the rail is reachable, and every settings page answering from the growth port's refusal — the state the shipped build is in.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T08:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T08:00:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Settings" },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: { sessions: [{ sessionId: SESSION_ID, title: "Settings", state: "active" }] },
    },
    { call: "agent.list", result: { agents: [] } },
  ],
};
