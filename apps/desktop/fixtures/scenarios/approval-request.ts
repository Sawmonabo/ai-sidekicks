// The approval-request scenario: one request already approved, and three still waiting, all
// raised by one agent in one run of the user's session.
//
// The three waiting are a destructive git command, a file write, and a provider
// permission ask. Several requests rather than one, so a view that shows the waiting
// ones has more than one card to be a barrier across, and one already approved to show
// it does not count a settled request as waiting.
//
// The approval beats carry the REGISTERED payload — the approval-flow event kinds shape it
// `{sessionId, runId?, approvalRequestId?, askId?, category, scope, requestedBy?,
// resourceDescriptor?, expiryAt?, approver?, effectiveScope?, …}` — because a
// payload no view reads is still a payload a daemon emits, and a beat
// carrying a thinner one would be teaching the wire a shape it does not have.
//
// `tests/helpers/scenario-contract-check/contract-check.ts` holds the beats to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict payload layer
// (`SessionEventSchema`), both in `packages/contracts/src/event.ts`. The `approval.*`
// beats reach the census leg alone, since nothing has registered their variants
// yet; `session.created` and `agent.attached` reach both, which is why the first
// carries `{sessionId, config, metadata}` and the second carries `name` rather than
// the `displayName` that is on no wire in this corpus.
//
// IDENTIFIERS ARE UUIDS. `SessionId`, `UserId`, `AgentId`, `RunId`, and
// `ApprovalRequestId` are branded ids the contracts declare over UUID values, and a
// readable `approval-01` also renders at a third of the width a real one does — a
// design lie in a fixture whose whole job is to be measured.

import {
  UserIdSchema,
  RunIdSchema,
  SessionIdSchema,
  type UserId,
  type RunId,
  type SessionId,
} from "@ai-sidekicks/contracts";
import type { Scenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
//
// MINTED THROUGH THE REGISTERED SCHEMAS RATHER THAN `as`-CAST. A scenario constant is
// where a fixture chooses the bytes, and a cast asserts a brand without checking it —
// so a malformed id surfaced at the first `.strict()` reply that carried it, which
// takes the whole reply down and names the reply rather than the value. Parsing at
// declaration fails the module instead, naming the constant. `AGENT_*` stays
// unbranded: the corpus registers no `AgentId` brand to mint one through.
const SESSION_ID: SessionId = SessionIdSchema.parse("019b7a33-3300-75e5-8510-ada11a5a55a5");
const USER_YOU: UserId = UserIdSchema.parse("019b7a33-3300-79a4-8110-cca0117a0510");
const AGENT_IMPLEMENTER = "019b7a33-3300-7a6e-8110-d1a4c1150501";
const AGENT_REVIEWER = "019b7a33-3300-7a6e-8120-d1a4c1150502";
const RUN_ID: RunId = RunIdSchema.parse("019b7a33-3300-740e-8110-d1a4c1150511");

const APPROVAL_RESOLVED = "019b7a33-3300-7f01-8110-d1a4c1150521";
const APPROVAL_PENDING_GIT_RESET = "019b7a33-3300-7f01-8120-d1a4c1150522";
const APPROVAL_PENDING_WRITE = "019b7a33-3300-7f01-8130-d1a4c1150523";
const APPROVAL_PENDING_ASK = "019b7a33-3300-7f01-8140-d1a4c1150524";

/**
 * The originating driver ask, carried on the `approval.requested` EVENT payload.
 *
 * Registered there and persisted on the request row.
 */
const DRIVER_ASK_ID = "ask-permission-force-push";

export const APPROVAL_REQUEST_SCENARIO: Scenario = {
  id: "approval-request",
  label: "A decision waiting",
  purpose:
    "Three requests waiting, one of them a provider permission ask, beside one that is " +
    "already approved, so a view that lists the waiting ones can be held to leaving the " +
    "approved one out.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: [USER_YOU, AGENT_IMPLEMENTER, AGENT_REVIEWER],
  // The person the pending cards are addressed to. Stated rather than inferred:
  // an approvals view that guessed its caller would render an approve control for
  // whoever happens to be first in the join log.
  callerUserId: USER_YOU,
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
        actorId: USER_YOU,
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
        actorId: USER_YOU,
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_IMPLEMENTER,
          name: "Implementer",
          driverName: "claude",
          modelId: "claude-sonnet-5",
          actor: USER_YOU,
        },
      },
    },
    {
      atMs: 120,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350003",
        sessionId: SESSION_ID,
        sequence: 3,
        // The run every request below was raised by, reaching `running`. The posture
        // is stamped on THIS transition and on no other — the post-setup-gate spawn
        // success, where the resolved workspace root and the effective posture are
        // final — so the boundary a person is deciding under is a fact about this
        // beat rather than a standing property of the run.
        kind: "run.running",
        occurredAt: "2026-01-01T13:30:00.120Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 2,
          previousState: "starting",
          newState: "running",
          executionPosture: {
            mode: "workspace-sandboxed",
            credentialPolicyRef:
              "sha256:7c4e1b93a52f6d08e14b7c93a52f6d08e14b7c93a52f6d08e14b7c93a52f6d08",
            networkAccess: "allowed-domains",
            allowedDomains: ["registry.npmjs.org", "github.com"],
            writableRoots: ["/Users/dev/code/ai-sidekicks"],
          },
        },
      },
    },
    {
      atMs: 200,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350004",
        sessionId: SESSION_ID,
        sequence: 4,
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
        id: "019b7a33-3300-7e00-8110-e5e0c3350005",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "approval.approved",
        occurredAt: "2026-01-01T13:30:00.420Z",
        actorId: USER_YOU,
        // The resolution events carry the approver and the scope that took effect.
        // `effectiveScope` is never broader than what was requested.
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_RESOLVED,
          category: "tool_execution",
          scope: "run",
          approver: USER_YOU,
          effectiveScope: "run",
        },
      },
    },
    {
      atMs: 600,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350006",
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.600Z",
        actorId: AGENT_IMPLEMENTER,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          approvalRequestId: APPROVAL_PENDING_GIT_RESET,
          category: "destructive_git",
          scope: "session",
          requestedBy: AGENT_IMPLEMENTER,
          resourceDescriptor: { command: "git reset --hard origin/develop", branch: "develop" },
        },
      },
    },
    {
      atMs: 900,
      event: {
        id: "019b7a33-3300-7e00-8110-e5e0c3350008",
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
        id: "019b7a33-3300-7e00-8110-e5e0c3350009",
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
  replies: [],
};
