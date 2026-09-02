// The flagship scenario — skeleton.
//
// The full four-lane session (four agents streaming at once, an approval landing
// mid-stream, a cost meter moving, a thread drawn between two runs) is
// T-023p-1C-2's, because it is only meaningful once the ledger, cast bar, and
// timeline surfaces exist to render it. What lands here is the SKELETON those
// surfaces will be built against: the participant roster in join order, one agent
// per lane, and the opening beats that put a row on screen.
//
// The roster is the load-bearing part. `Spec-023 §Console Design (Meridian)` rule 2
// allocates participant hues by join-log order, so the order of
// `participantIdsInJoinOrder` below is what the hue allocator consumes and what a
// screenshot baseline depends on. Reordering it is a visual change, not a cosmetic
// one — which is why it is stated here once and read everywhere.

import type { ConsoleScenario } from "../scenario.js";

export const FLAGSHIP_SCENARIO_ID = "flagship";

const SESSION_ID = "session-flagship";

export const FLAGSHIP_SCENARIO: ConsoleScenario = {
  id: FLAGSHIP_SCENARIO_ID,
  label: "Four lanes",
  purpose:
    "A live session with four agents working at once. The skeleton lands here; T-023p-1C-2 fills in the streaming lanes, the mid-stream approval, and the run thread.",
  sessionId: SESSION_ID,
  // Join order IS the hue order. Two people first, then the agents in the order
  // they were attached — which is what a real session's join log looks like.
  participantIdsInJoinOrder: [
    "participant-you",
    "participant-priya",
    "agent-architect",
    "agent-implementer",
    "agent-reviewer",
    "agent-scout",
  ],
  startedAtIso: "2026-01-01T14:20:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T14:20:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Rate-limit wiring" },
      },
    },
    {
      atMs: 40,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "participant.joined",
        occurredAt: "2026-01-01T14:20:00.040Z",
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
        occurredAt: "2026-01-01T14:20:00.120Z",
        actorParticipantId: "agent-architect",
        payload: { agentId: "agent-architect", displayName: "Architect" },
      },
    },
    {
      atMs: 160,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.attached",
        occurredAt: "2026-01-01T14:20:00.160Z",
        actorParticipantId: "agent-implementer",
        payload: { agentId: "agent-implementer", displayName: "Implementer" },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "agent.attached",
        occurredAt: "2026-01-01T14:20:00.200Z",
        actorParticipantId: "agent-reviewer",
        payload: { agentId: "agent-reviewer", displayName: "Reviewer" },
      },
    },
    {
      atMs: 240,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "agent.attached",
        occurredAt: "2026-01-01T14:20:00.240Z",
        actorParticipantId: "agent-scout",
        payload: { agentId: "agent-scout", displayName: "Scout" },
      },
    },
    {
      atMs: 320,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "run.queued",
        occurredAt: "2026-01-01T14:20:00.320Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-01", agentId: "agent-implementer" },
      },
    },
    {
      atMs: 400,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "run.started",
        occurredAt: "2026-01-01T14:20:00.400Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-01" },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: {
        sessions: [{ sessionId: SESSION_ID, title: "Rate-limit wiring", state: "active" }],
      },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          { agentId: "agent-architect", displayName: "Architect", state: "idle" },
          { agentId: "agent-implementer", displayName: "Implementer", state: "running" },
          { agentId: "agent-reviewer", displayName: "Reviewer", state: "idle" },
          { agentId: "agent-scout", displayName: "Scout", state: "idle" },
        ],
      },
    },
  ],
};
