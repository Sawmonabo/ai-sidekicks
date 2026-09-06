// What the approvals scenario ANSWERS, as opposed to what it plays.
//
// A reply is a read and a beat is a stream frame, and the fixture serves them through
// different seams: a call is looked up here by method and answered once, while a beat
// is routed to a subscription by kind and arrives on the frozen clock. The pane reads
// its queue through the growth port and watches it change through the tail, so the
// two halves answer two different questions about the same six requests.

import type { ScenarioReply } from "../scenario-runtime/scenario.js";
import {
  SESSION_ID,
  PARTICIPANT_YOU,
  PARTICIPANT_AWAY,
  AGENT_IMPLEMENTER,
  AGENT_REVIEWER,
  RUN_ID,
  APPROVAL_RESOLVED,
  APPROVAL_EXPIRED,
  APPROVAL_PENDING_WRITE,
  APPROVAL_PENDING_ASK,
  APPROVAL_REJECTED,
  APPROVAL_CANCELED,
  RULE_SESSION_WIDE,
  RULE_RUN_SCOPED,
  RULE_REVOKED,
  NODE_ID,
} from "./approvals.identifiers.js";

/** Every call the approvals scenario answers, and what it answers with. */
export const APPROVALS_REPLIES: readonly ScenarioReply[] = [
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
    // The member names inside a descriptor are the daemon's own composition — the
    // wire types it an open `Record<string, unknown>` and registers no vocabulary
    // for its keys, so the surface renders whatever members arrive and names none
    // of them itself.
    result: {
      approvals: [
        {
          id: APPROVAL_PENDING_WRITE,
          runId: RUN_ID,
          requestedBy: AGENT_IMPLEMENTER,
          category: "file_write",
          scope: "session",
          resourceDescriptor: {
            path: "packages/runtime-daemon/src/store/migrations/0012.sql",
            bytes: 4096,
          },
          state: "pending",
          createdAt: "2026-01-01T13:30:00.900Z",
          updatedAt: "2026-01-01T13:30:00.900Z",
          expiryAt: "2026-01-01T17:30:00.900Z",
        },
        // The request that arrived as a provider permission ask. It carries no
        // marker of that origin, because the projection reply registers none: the
        // `askId` is on the EVENT payload and on the persisted row, and a fixture
        // that answered one here would be teaching a member into existence. The
        // pane joins this row to the projected entity to learn what the reply
        // cannot tell it.
        {
          id: APPROVAL_PENDING_ASK,
          runId: RUN_ID,
          requestedBy: AGENT_IMPLEMENTER,
          category: "tool_execution",
          scope: "run",
          resourceDescriptor: {
            command: "git push --force origin feature/rebased",
            branch: "feature/rebased",
          },
          state: "pending",
          createdAt: "2026-01-01T13:30:01.100Z",
          updatedAt: "2026-01-01T13:30:01.100Z",
          expiryAt: "2026-01-01T17:30:01.100Z",
        },
        {
          id: APPROVAL_RESOLVED,
          runId: RUN_ID,
          requestedBy: AGENT_IMPLEMENTER,
          category: "tool_execution",
          scope: "run",
          resourceDescriptor: { command: "pnpm --filter @ai-sidekicks/desktop run build" },
          state: "approved",
          createdAt: "2026-01-01T13:30:00.200Z",
          updatedAt: "2026-01-01T13:30:00.420Z",
          expiryAt: "2026-01-01T17:30:00.200Z",
          resolvedAt: "2026-01-01T13:30:00.420Z",
          decision: "approved",
          approverId: PARTICIPANT_YOU,
          effectiveScope: "run",
          // The resolution that minted a rule. An OBJECT, as the wire declares
          // it, and the one row here that carries a narrowing pattern.
          rememberedScope: { kind: "run", pattern: "pnpm --filter @ai-sidekicks/desktop" },
        },
        {
          id: APPROVAL_EXPIRED,
          runId: RUN_ID,
          requestedBy: AGENT_IMPLEMENTER,
          category: "destructive_git",
          scope: "session",
          resourceDescriptor: { command: "git reset --hard origin/develop", branch: "develop" },
          state: "expired",
          createdAt: "2026-01-01T13:30:00.600Z",
          // An expired row settles on `updatedAt`; there is no resolution row.
          updatedAt: "2026-01-01T13:30:00.780Z",
          expiryAt: "2026-01-01T13:30:00.780Z",
        },
        // The remaining two members of the five-state union. A `rejected` record
        // carries the resolved quad exactly as an `approved` one does, and a
        // `canceled` one carries none, because it was never resolved by anybody.
        {
          id: APPROVAL_REJECTED,
          runId: RUN_ID,
          requestedBy: AGENT_REVIEWER,
          category: "network_access",
          scope: "run",
          resourceDescriptor: { host: "registry.example.invalid", method: "GET" },
          state: "rejected",
          createdAt: "2026-01-01T13:29:00.000Z",
          updatedAt: "2026-01-01T13:29:10.000Z",
          resolvedAt: "2026-01-01T13:29:10.000Z",
          decision: "rejected",
          approverId: PARTICIPANT_YOU,
          effectiveScope: "run",
        },
        {
          id: APPROVAL_CANCELED,
          runId: RUN_ID,
          requestedBy: AGENT_REVIEWER,
          category: "plan_approval",
          scope: "session",
          resourceDescriptor: { planId: "plan-console-shell", steps: 4 },
          state: "canceled",
          createdAt: "2026-01-01T13:28:40.000Z",
          updatedAt: "2026-01-01T13:28:55.000Z",
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
];
