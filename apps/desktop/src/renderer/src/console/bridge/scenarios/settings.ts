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
//
// Its one beat is held to the shipped wire contract by `scenarios/wire-truth.ts`,
// exactly as the substrate's two are: the identifiers are the branded UUIDs the
// strict layer declares, and `session.created` carries `{sessionId, config,
// metadata}` rather than a title, which its `.strict()` schema rejects.

import type { ConsoleScenario } from "../scenario.js";

export const SETTINGS_SCENARIO_ID = "settings";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
const SESSION_ID = "019b7892-1c00-75e5-8510-ada11a5a55a5";
const PARTICIPANT_YOU = "019b7892-1c00-79a4-8110-cca0117a0550";

export const SETTINGS_SCENARIO: ConsoleScenario = {
  id: SETTINGS_SCENARIO_ID,
  label: "Settings, nothing asked",
  purpose:
    "One quiet session so the rail is reachable, and every settings page answering from the growth port's refusal — the state the shipped build is in.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU],
  startedAtIso: "2026-01-01T08:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T08:00:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
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
