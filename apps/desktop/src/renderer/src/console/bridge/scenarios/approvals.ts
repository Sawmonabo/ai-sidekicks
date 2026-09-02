// The approvals scenario: every state the closed union carries, plus the standing
// permissions that outlive them.
//
// Six records rather than one, because the approvals surface's hardest claim is that
// history renders every state an unfiltered read returns and drops nothing. A
// fixture carrying only a pending card would let a history view that quietly dropped
// the terminal states look correct — and one carrying only three would let a view
// that dropped `rejected` or `canceled` look correct too, so the projection read
// below covers all five members of `ApprovalState`, the two pending ones twice over
// so the wait-for-all barrier has more than one card to be a barrier across.
//
// The lifecycle beats are opaque re-read triggers by design: the surface's rule is
// that those five event payloads are never decoded. They still carry the REGISTERED
// payload — `Spec-006 §Approval Flow (approval_flow)` shapes it
// `{sessionId, runId?, approvalRequestId?, askId?, category, scope, requestedBy?,
// resourceDescriptor?, expiryAt?, approver?, effectiveScope?, …}` — because a
// payload a surface does not read is still a payload a daemon emits, and a beat
// carrying a thinner one would be teaching the wire a shape it does not have.
// Opacity is a rule about the CONSUMER, never a licence for the producer.
//
// `scenarios/wire-truth.ts` holds the beats to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict payload layer
// (`SessionEventSchema`), both in `packages/contracts/src/event.ts`. The `approval.*`
// beats reach the census leg alone, since Plan-012 has not registered their variants
// yet; `session.created` and `agent.attached` reach both, which is why the first
// carries `{sessionId, config, metadata}` and the second carries `name` rather than
// the `displayName` that is on no wire in this corpus.
//
// IDENTIFIERS ARE UUIDS, with one deliberate exception. `SessionId`,
// `ParticipantId`, `AgentId`, `RunId`, and `ApprovalRequestId` are branded ids the
// contracts declare over UUID values, and a readable `approval-01` also renders at a
// third of the width a real one does — a design lie in a fixture whose whole job is
// to be measured. `NodeId` is the exception: `packages/contracts/src/node-id.ts`
// declares it a bounded string and nothing narrows it to a UUID, so the node below
// is spelled the way an operator would actually name a machine.

import type { ConsoleScenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
const PARTICIPANT_YOU = "019b7a33-3300-79a4-8110-cca0117a0510";
const PARTICIPANT_AWAY = "019b7a33-3300-79a4-8120-cca0117a0520";
const AGENT_IMPLEMENTER = "019b7a33-3300-7a6e-8110-d1a4c1150501";
const AGENT_REVIEWER = "019b7a33-3300-7a6e-8120-d1a4c1150502";
const RUN_ID = "019b7a33-3300-740e-8110-d1a4c1150511";

const APPROVAL_RESOLVED = "019b7a33-3300-7f01-8110-d1a4c1150521";
const APPROVAL_EXPIRED = "019b7a33-3300-7f01-8120-d1a4c1150522";
const APPROVAL_PENDING_WRITE = "019b7a33-3300-7f01-8130-d1a4c1150523";
const APPROVAL_PENDING_ASK = "019b7a33-3300-7f01-8140-d1a4c1150524";
const APPROVAL_REJECTED = "019b7a33-3300-7f01-8150-d1a4c1150525";
const APPROVAL_CANCELED = "019b7a33-3300-7f01-8160-d1a4c1150526";

const RULE_SESSION_WIDE = "019b7a33-3300-7b01-8110-d1a4c1150531";
const RULE_RUN_SCOPED = "019b7a33-3300-7b01-8120-d1a4c1150532";
const RULE_REVOKED = "019b7a33-3300-7b01-8130-d1a4c1150533";

/**
 * The originating driver ask, carried on the permission-kind request.
 *
 * `askId` routes a normalized permission ask to the ask card rather than the plain
 * one, so exactly one of the two renders it. It is a driver-scoped identifier and
 * not one of the branded id types, which is why it is not a UUID here.
 */
const DRIVER_ASK_ID = "ask-permission-force-push";

/** The node the remembered rules are bound to. `NodeId` is a bounded string. */
const NODE_ID = "workstation-local";

export const APPROVALS_SCENARIO: ConsoleScenario = {
  id: "approvals",
  label: "A decision waiting",
  purpose:
    "Two requests waiting beside four that are settled — every member of the closed five-state union, so the approvals pane and its history can be held to dropping none of them.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, PARTICIPANT_AWAY, AGENT_IMPLEMENTER, AGENT_REVIEWER],
  // The person the two pending cards are addressed to. Stated rather than inferred:
  // an approvals surface that guessed its viewer would render an approve control for
  // whoever happens to be first in the join log.
  viewingParticipantId: PARTICIPANT_YOU,
  startedAtIso: "2026-01-01T13:30:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T13:30:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 40,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T13:30:00.040Z",
        // The person who attached the agent, not the agent.
        actorParticipantId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_IMPLEMENTER,
          name: "Implementer",
          driverName: "claude",
          modelId: "claude-sonnet-5",
          state: "ready",
          actor: PARTICIPANT_YOU,
        },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.200Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_RESOLVED,
          category: "tool_execution",
          scope: "run",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: "pnpm --filter @ai-sidekicks/desktop run build",
          expiryAt: "2026-01-01T17:30:00.200Z",
        },
      },
    },
    {
      atMs: 420,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "approval.approved",
        occurredAt: "2026-01-01T13:30:00.420Z",
        actorParticipantId: PARTICIPANT_YOU,
        // The resolution events carry the approver and the scope that took effect.
        // `effectiveScope` is never broader than what was requested.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_RESOLVED,
          category: "tool_execution",
          scope: "run",
          approver: PARTICIPANT_YOU,
          effectiveScope: "run",
        },
      },
    },
    {
      atMs: 600,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.600Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_EXPIRED,
          category: "destructive_git",
          scope: "session",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: "git reset --hard origin/develop",
          expiryAt: "2026-01-01T13:30:00.780Z",
        },
      },
    },
    {
      atMs: 780,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        // Expiry never auto-approves, at any tier and any posture. The console
        // performs no expiry arithmetic of its own: this state arrives on the wire.
        kind: "approval.expired",
        occurredAt: "2026-01-01T13:30:00.780Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_EXPIRED,
          category: "destructive_git",
          scope: "session",
        },
      },
    },
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.900Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_PENDING_WRITE,
          category: "file_write",
          scope: "session",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: "write packages/runtime-daemon/src/store/migrations/0012.sql",
          expiryAt: "2026-01-01T17:30:00.900Z",
        },
      },
    },
    {
      atMs: 1_100,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        // The second pending request, and the one that arrived as a provider
        // permission ask: `askId` is the originating `driver_ask` identifier, and it
        // is what routes this record to the ask card rather than the plain one.
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:01.100Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_PENDING_ASK,
          askId: DRIVER_ASK_ID,
          category: "tool_execution",
          scope: "run",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: "git push --force origin feature/rebased",
          expiryAt: "2026-01-01T17:30:01.100Z",
        },
      },
    },
  ],
  replies: [
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
            // The four-state agent lifecycle. A run waiting on an approval is a RUN
            // state and is read from the run, never folded into the agent row.
            state: "ready",
            createdAt: "2026-01-01T13:30:00.040Z",
          },
        ],
      },
    },
    {
      call: "approval.projectionRead",
      // An unfiltered read: every state the closed five-member union carries, with
      // the resolved quad present exactly on the two resolved arms and `expiryAt`
      // verbatim on the ones that have one. The console never filters by state
      // itself — the filter is a server-side one this read deliberately does not use.
      result: {
        requests: [
          {
            approvalRequestId: APPROVAL_PENDING_WRITE,
            category: "file_write",
            state: "pending",
            requestedBy: AGENT_IMPLEMENTER,
            requestedScope: "session",
            resourceDescriptor: "write packages/runtime-daemon/src/store/migrations/0012.sql",
            expiryAt: "2026-01-01T17:30:00.900Z",
            auditMetadata: { origin: "tool", turn: "7" },
          },
          // A permission-kind driver ask, normalized into the approval model: the
          // `askId` is what routes it to the ask card rather than the plain one, so
          // exactly one of the two renders it.
          {
            approvalRequestId: APPROVAL_PENDING_ASK,
            category: "tool_execution",
            state: "pending",
            requestedBy: AGENT_IMPLEMENTER,
            requestedScope: "run",
            resourceDescriptor: "git push --force origin feature/rebased",
            expiryAt: "2026-01-01T17:30:01.100Z",
            askId: DRIVER_ASK_ID,
          },
          {
            approvalRequestId: APPROVAL_RESOLVED,
            category: "tool_execution",
            state: "approved",
            requestedBy: AGENT_IMPLEMENTER,
            requestedScope: "run",
            expiryAt: "2026-01-01T17:30:00.200Z",
            resolvedAt: "2026-01-01T13:30:00.420Z",
            decision: "approved",
            approverId: PARTICIPANT_YOU,
            effectiveScope: "run",
          },
          {
            approvalRequestId: APPROVAL_EXPIRED,
            category: "destructive_git",
            state: "expired",
            requestedBy: AGENT_IMPLEMENTER,
            requestedScope: "session",
            expiryAt: "2026-01-01T13:30:00.780Z",
          },
          // The remaining two members of the five-state union. A `rejected` record
          // carries the resolved quad exactly as an `approved` one does, and a
          // `canceled` one carries none, because it was never resolved by anybody.
          {
            approvalRequestId: APPROVAL_REJECTED,
            category: "network_access",
            state: "rejected",
            requestedBy: AGENT_REVIEWER,
            requestedScope: "run",
            resourceDescriptor: "fetch https://registry.example.invalid/index",
            resolvedAt: "2026-01-01T13:29:10.000Z",
            decision: "rejected",
            approverId: PARTICIPANT_YOU,
            effectiveScope: "run",
          },
          {
            approvalRequestId: APPROVAL_CANCELED,
            category: "plan_approval",
            state: "canceled",
            requestedBy: AGENT_REVIEWER,
            requestedScope: "session",
          },
        ],
      },
    },
    {
      call: "approval.ruleList",
      // Read with `includeRevoked: true`, so this list IS the audit history: a live
      // session-wide rule, a run-scoped one carrying its `runId`, and a dead one
      // whose trigger is named rather than left mysterious.
      result: {
        rules: [
          {
            ruleId: RULE_SESSION_WIDE,
            sessionId: SESSION_ID,
            participantId: PARTICIPANT_YOU,
            nodeId: NODE_ID,
            category: "tool_execution",
            scope: { kind: "session" },
            grantedAt: "2026-01-01T13:28:00.000Z",
          },
          {
            ruleId: RULE_RUN_SCOPED,
            sessionId: SESSION_ID,
            participantId: PARTICIPANT_YOU,
            nodeId: NODE_ID,
            runId: RUN_ID,
            category: "file_write",
            scope: { kind: "run", pattern: "packages/contracts/**" },
            grantedAt: "2026-01-01T13:28:30.000Z",
          },
          {
            ruleId: RULE_REVOKED,
            sessionId: SESSION_ID,
            participantId: PARTICIPANT_AWAY,
            nodeId: NODE_ID,
            category: "network_access",
            scope: { kind: "session" },
            grantedAt: "2026-01-01T12:00:00.000Z",
            revokedAt: "2026-01-01T13:10:00.000Z",
            invalidationTrigger: "membership_change",
          },
        ],
      },
    },
    // The two mutations answer, and answer with nothing a renderer could settle a
    // record from: what a record BECAME is the next projection read's answer, so a
    // reply that carried a state would invite a card to settle itself.
    { call: "approval.resolve", result: {} },
    {
      call: "approval.ruleRevoke",
      result: {
        ruleId: RULE_SESSION_WIDE,
        revokedAt: "2026-01-01T13:31:00.000Z",
        invalidationTrigger: "explicit",
      },
    },
  ],
};
