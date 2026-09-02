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
// Every `kind` is a registered wire event type. `agent.config_updated` is what the
// console gets today; the switch-terminal types the card reads beside it are on the
// roster lane's growth reading and are deliberately not scripted here, because a
// scenario is fixture data and not a place to mint wire shapes.

import type { ConsoleScenario } from "../scenario.js";

export const AGENTS_SCENARIO_ID = "agents";

const SESSION_ID = "session-agents";

export const AGENTS_SCENARIO: ConsoleScenario = {
  id: AGENTS_SCENARIO_ID,
  label: "Two agents, one re-bound",
  purpose:
    "A session with two attached agents, one of which is re-bound while it is attached — the case that separates the effective binding from a pending one.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you", "agent-architect", "agent-implementer"],
  startedAtIso: "2026-01-01T11:30:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:30:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Driver parity" },
      },
    },
    {
      atMs: 80,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:30:00.080Z",
        actorParticipantId: "agent-architect",
        payload: { agentId: "agent-architect", name: "Architect" },
      },
    },
    {
      atMs: 140,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:30:00.140Z",
        actorParticipantId: "agent-implementer",
        payload: { agentId: "agent-implementer", name: "Implementer" },
      },
    },
    {
      atMs: 320,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.config_updated",
        occurredAt: "2026-01-01T11:30:00.320Z",
        actorParticipantId: "participant-you",
        payload: { agentId: "agent-implementer" },
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
          { agentId: "agent-architect", name: "Architect", state: "ready" },
          { agentId: "agent-implementer", name: "Implementer", state: "ready" },
        ],
      },
    },
  ],
};
