// The agents scenario — skeleton.
//
// One session, two attached agents, and one of them re-bound mid-session. That last
// beat is the point of the scenario rather than decoration: the agent card's hardest
// rule is that the EFFECTIVE binding and a PENDING switch are two different lines
// and the effective columns move only when the terminal event lands
// (`Spec-023 §Console Design (Meridian)` §The agent card). A scenario with only
// `agent.attached` beats can never exercise that, so the card would be built
// against a case that cannot go wrong.
//
// Every `kind` is a registered wire event type CARRYING THE REGISTERED PAYLOAD, and
// `scenarios/wire-truth.ts` holds this file to both. Two consequences a reader meets
// first, the same two `flagship.ts` records: the identifiers are the branded UUIDs
// the strict layer declares, and `session.created` carries `{sessionId, config,
// metadata}` rather than a title — a session's display name reaches the console from
// the session read, never from the creation event.
//
// `agent.config_updated` is what the console gets today; the switch-terminal types
// the card reads beside it are on the roster lane's growth reading and are
// deliberately not scripted here, because a scenario is fixture data and not a place
// to mint wire shapes.

import type { ConsoleScenario } from "../scenario.js";

export const AGENTS_SCENARIO_ID = "agents";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
const SESSION_ID = "019b7952-5ec0-75e5-8510-ada11a5a44a5";
const PARTICIPANT_YOU = "019b7952-5ec0-79a4-8110-cca0117a0440";
const AGENT_ARCHITECT = "019b7952-5ec0-7a6e-8110-d1a4c1150041";
const AGENT_IMPLEMENTER = "019b7952-5ec0-7a6e-8120-d1a4c1150042";

export const AGENTS_SCENARIO: ConsoleScenario = {
  id: AGENTS_SCENARIO_ID,
  label: "Two agents, one re-bound",
  purpose:
    "A session with two attached agents, one of which is re-bound while it is attached — the case that separates the effective binding from a pending one.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, AGENT_ARCHITECT, AGENT_IMPLEMENTER],
  startedAtIso: "2026-01-01T11:30:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:30:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 80,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:30:00.080Z",
        actorParticipantId: AGENT_ARCHITECT,
        payload: { agentId: AGENT_ARCHITECT, name: "Architect" },
      },
    },
    {
      atMs: 140,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:30:00.140Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { agentId: AGENT_IMPLEMENTER, name: "Implementer" },
      },
    },
    {
      atMs: 320,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.config_updated",
        occurredAt: "2026-01-01T11:30:00.320Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { agentId: AGENT_IMPLEMENTER },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: {
        sessions: [{ sessionId: SESSION_ID, title: "Driver parity", state: "active" }],
      },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          { agentId: AGENT_ARCHITECT, name: "Architect", state: "ready" },
          { agentId: AGENT_IMPLEMENTER, name: "Implementer", state: "ready" },
        ],
      },
    },
  ],
};
