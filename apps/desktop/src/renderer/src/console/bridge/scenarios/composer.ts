// The composer scenario: a session addressed to something, with a message pending.
//
// It exists so the composer's zones have a session to be addressed WITHIN. Two
// people and two agents, so a target is a real choice rather than the only one, and
// the newest run is `waiting_for_input` — the state in which a person's next
// sentence is the thing the session is blocked on, which is the moment the composer
// matters most.
//
// The beats carry wire-verbatim event kinds and nothing else. A scenario is data,
// so an invented kind here would be an invented kind everywhere it is projected.

import type { ConsoleScenario } from "../scenario.js";

const SESSION_ID = "session-composer";

export const COMPOSER_SCENARIO: ConsoleScenario = {
  id: "composer",
  label: "Awaiting a reply",
  purpose:
    "A session whose newest run is blocked on a person's next message — the state the composer's target, posture, and send resolution are read against.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [
    "participant-you",
    "participant-priya",
    "agent-implementer",
    "agent-reviewer",
  ],
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Composer addressing" },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "participant.joined",
        occurredAt: "2026-01-01T11:05:00.060Z",
        actorParticipantId: "participant-priya",
        payload: { displayName: "Priya" },
      },
    },
    {
      atMs: 120,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:05:00.120Z",
        actorParticipantId: "agent-implementer",
        payload: { agentId: "agent-implementer", displayName: "Implementer" },
      },
    },
    {
      atMs: 180,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:05:00.180Z",
        actorParticipantId: "agent-reviewer",
        payload: { agentId: "agent-reviewer", displayName: "Reviewer" },
      },
    },
    {
      atMs: 260,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.260Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-compose-01", agentId: "agent-implementer" },
      },
    },
    {
      atMs: 320,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "run.started",
        occurredAt: "2026-01-01T11:05:00.320Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-compose-01" },
      },
    },
    {
      atMs: 480,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        // Waiting is not pausing: this run is blocked on someone, and the composer
        // is where that someone answers.
        kind: "run.blocked",
        occurredAt: "2026-01-01T11:05:00.480Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-compose-01", state: "waiting_for_input" },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: {
        sessions: [{ sessionId: SESSION_ID, title: "Composer addressing", state: "active" }],
      },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          { agentId: "agent-implementer", displayName: "Implementer", state: "waiting_for_input" },
          { agentId: "agent-reviewer", displayName: "Reviewer", state: "idle" },
        ],
      },
    },
  ],
};
