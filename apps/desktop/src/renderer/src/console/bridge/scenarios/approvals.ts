// The approvals scenario: one decision pending, one resolved, one expired.
//
// Three records rather than one, because the approvals surface's hardest claim is
// that history renders every state an unfiltered read returns and drops nothing. A
// fixture carrying only a pending card would let a history view that quietly
// dropped the terminal states look correct.
//
// The lifecycle beats are opaque re-read triggers by design: the surface's rule is
// that those five event payloads are never decoded, so the payloads here carry the
// record identity and nothing a renderer could be tempted to read a decision out of.

import type { ConsoleScenario } from "../scenario.js";

const SESSION_ID = "session-approvals";

export const APPROVALS_SCENARIO: ConsoleScenario = {
  id: "approvals",
  label: "A decision waiting",
  purpose:
    "One pending request beside a resolved one and an expired one — the three shapes the approvals pane and its history must render without performing expiry arithmetic of its own.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you", "agent-implementer"],
  startedAtIso: "2026-01-01T13:30:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T13:30:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Approvals" },
      },
    },
    {
      atMs: 40,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T13:30:00.040Z",
        actorParticipantId: "agent-implementer",
        payload: { agentId: "agent-implementer", displayName: "Implementer" },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.200Z",
        actorParticipantId: "agent-implementer",
        payload: { approvalRequestId: "approval-01" },
      },
    },
    {
      atMs: 420,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "approval.approved",
        occurredAt: "2026-01-01T13:30:00.420Z",
        actorParticipantId: "participant-you",
        payload: { approvalRequestId: "approval-01" },
      },
    },
    {
      atMs: 600,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.600Z",
        actorParticipantId: "agent-implementer",
        payload: { approvalRequestId: "approval-02" },
      },
    },
    {
      atMs: 780,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "approval.expired",
        occurredAt: "2026-01-01T13:30:00.780Z",
        actorParticipantId: "agent-implementer",
        payload: { approvalRequestId: "approval-02" },
      },
    },
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.900Z",
        actorParticipantId: "agent-implementer",
        payload: { approvalRequestId: "approval-03" },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: { sessions: [{ sessionId: SESSION_ID, title: "Approvals", state: "active" }] },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          {
            agentId: "agent-implementer",
            displayName: "Implementer",
            state: "waiting_for_approval",
          },
        ],
      },
    },
    {
      call: "approval.projectionRead",
      // An unfiltered read: every state the closed five-member union carries that
      // this session has reached, with the resolved quad present exactly on the two
      // resolved arms and `expiryAt` verbatim on the ones that have one.
      result: {
        requests: [
          {
            approvalRequestId: "approval-03",
            category: "file_write",
            state: "pending",
            requestedBy: "agent-implementer",
            requestedScope: "session",
            expiryAt: "2026-01-01T17:30:00.900Z",
          },
          {
            approvalRequestId: "approval-01",
            category: "tool_execution",
            state: "approved",
            requestedBy: "agent-implementer",
            requestedScope: "run",
            expiryAt: "2026-01-01T17:30:00.200Z",
            resolvedAt: "2026-01-01T13:30:00.420Z",
            decision: "approved",
            approverId: "participant-you",
            effectiveScope: "run",
          },
          {
            approvalRequestId: "approval-02",
            category: "destructive_git",
            state: "expired",
            requestedBy: "agent-implementer",
            requestedScope: "session",
            expiryAt: "2026-01-01T13:30:00.780Z",
          },
        ],
      },
    },
  ],
};
