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
// THE PROJECTION REPLY IS THE REGISTERED ONE, key for key. `approval.projectionRead`
// answers `{ approvals: [{ id, runId, requestedBy, category, scope, resourceDescriptor,
// state, createdAt, updatedAt, ... }] }`, and every row below is written that way — a
// fixture that answered a shape the corpus has not registered would teach the surface
// a wire that does not exist, and the surface would then be tested against the lie.
//
// IDENTIFIERS ARE UUIDS, with one deliberate exception. `SessionId`,
// `ParticipantId`, `AgentId`, `RunId`, and `ApprovalRequestId` are branded ids the
// contracts declare over UUID values, and a readable `approval-01` also renders at a
// third of the width a real one does — a design lie in a fixture whose whole job is
// to be measured. `NodeId` is the exception: `packages/contracts/src/node-id.ts`
// declares it a bounded string and nothing narrows it to a UUID, so the node below
// is spelled the way an operator would actually name a machine.

import type { ConsoleScenario } from "../scenario-runtime/index.js";
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
  DRIVER_ASK_ID,
} from "./approvals.identifiers.js";
import { APPROVALS_REPLIES } from "./approvals.replies.js";

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
  // The membership each PERSON in the roster holds. The two agents in the join order
  // take no entry: an agent is attached rather than admitted, so it holds no
  // membership and the fixture does not claim to know one. Without this, the viewer's
  // identity read succeeds into a roster carrying no role and every owner- and
  // collaborator-gated control renders closed for a reason nothing checked.
  membershipRoleByParticipantId: {
    [PARTICIPANT_YOU]: "owner",
    [PARTICIPANT_AWAY]: "collaborator",
  },
  startedAtIso: "2026-01-01T13:30:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T13:30:00.000Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 40,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350002",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T13:30:00.040Z",
        // The person who attached the agent, not the agent.
        actorId: PARTICIPANT_YOU,
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
        id: "019b7a33-3300-7e00-8110-e5e0c3350003",
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.200Z",
        actorId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_RESOLVED,
          category: "tool_execution",
          scope: "run",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: { command: "pnpm --filter @ai-sidekicks/desktop run build" },
          expiryAt: "2026-01-01T17:30:00.200Z",
        },
      },
    },
    {
      atMs: 420,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350004",
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "approval.approved",
        occurredAt: "2026-01-01T13:30:00.420Z",
        actorId: PARTICIPANT_YOU,
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
        id: "019b7a33-3300-7e00-8110-e5e0c3350005",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.600Z",
        actorId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_EXPIRED,
          category: "destructive_git",
          scope: "session",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: { command: "git reset --hard origin/develop", branch: "develop" },
          expiryAt: "2026-01-01T13:30:00.780Z",
        },
      },
    },
    {
      atMs: 780,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350006",
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
        id: "019b7a33-3300-7e00-8110-e5e0c3350007",
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.900Z",
        actorId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_PENDING_WRITE,
          category: "file_write",
          scope: "session",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: {
            path: "packages/runtime-daemon/src/store/migrations/0012.sql",
            bytes: 4096,
          },
          expiryAt: "2026-01-01T17:30:00.900Z",
        },
      },
    },
    {
      atMs: 1_100,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350008",
        sessionId: SESSION_ID,
        sequence: 8,
        // The second pending request, and the one that arrived as a provider
        // permission ask: `askId` is the originating `driver_ask` identifier, and it
        // reaches the console HERE and on no read. The pane learns the origin by
        // joining its projection row to the `approval` entity this beat folds into,
        // so the framing it renders comes from the event and never from the reply.
        // `expiryAt` rides beside it because the wire requires the pair — an
        // `askId`-bearing request without its shared deadline refuses at the
        // emission parse, so a fixture carrying one alone would teach a shape no
        // daemon can send.
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:01.100Z",
        actorId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_PENDING_ASK,
          askId: DRIVER_ASK_ID,
          category: "tool_execution",
          scope: "run",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: {
            command: "git push --force origin feature/rebased",
            branch: "feature/rebased",
          },
          expiryAt: "2026-01-01T17:30:01.100Z",
        },
      },
    },
  ],
  replies: APPROVALS_REPLIES,
};
