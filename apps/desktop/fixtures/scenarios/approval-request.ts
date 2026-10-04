// The approval-request scenario: one request already approved and three still waiting, all
// raised by one agent in one run.
//
// The waiting three are a destructive git command, a file write and a provider permission
// ask: more than one card for a view to be a barrier across, beside an approved request a
// view must not count as waiting.
//
// Approval beats carry the full registered payload of each variant.
// `tests/helpers/scenario-contract-check/contract-check.ts` holds the beats to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and strict payload layer (`SessionEventSchema`) in
// `packages/contracts/src/event.ts`.
//
// Ids are UUIDs, as the contracts' branded ids require, and a short readable id would render
// narrower than a real one in a fixture that is measured.

import { AgentIdSchema, type AgentId } from "@ai-sidekicks/contracts/agent-definition";
import {
  UserIdSchema,
  SessionIdSchema,
  type UserId,
  type SessionId,
} from "@ai-sidekicks/contracts/session";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/provider-driver";
import { composeSessionCreatedPayload } from "../data/opening-entries.js";
import {
  composeScenarioInstant,
  composeScriptBeats,
  type ScriptEntry,
} from "../data/script-entries.js";
import type { Scenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's start instant, so a rendered id
// identifies its fixture. Parsed through the registered schemas, not cast, so a malformed id
// fails the module and names the constant instead of failing a later reply.
const SESSION_ID: SessionId = SessionIdSchema.parse("019b7a33-3300-75e5-8510-ada11a5a55a5");
const USER_YOU: UserId = UserIdSchema.parse("019b7a33-3300-79a4-8110-cca0117a0510");
const AGENT_IMPLEMENTER: AgentId = AgentIdSchema.parse("019b7a33-3300-7a6e-8110-d1a4c1150501");
const RUN_ID: RunId = RunIdSchema.parse("019b7a33-3300-740e-8110-d1a4c1150511");

const APPROVAL_RESOLVED = "019b7a33-3300-7f01-8110-d1a4c1150521";
const APPROVAL_PENDING_GIT_RESET = "019b7a33-3300-7f01-8120-d1a4c1150522";
const APPROVAL_PENDING_WRITE = "019b7a33-3300-7f01-8130-d1a4c1150523";
const APPROVAL_PENDING_ASK = "019b7a33-3300-7f01-8140-d1a4c1150524";

/** The daemon's durable id for the permission ask, carried on its `approval.requested` payload. */
const PERMISSION_ASK_ID = "ask-permission-force-push";
// The device the answer came from: this machine's own screen.
const ANSWERING_DEVICE_ID = "019b7a33-3300-7d02-8110-d1a4c1150541";

// The base instant, built with `Date.UTC` rather than by parsing a string, so the ISO spelling
// below cannot disagree with it.
const STARTED_AT_MS: number = Date.UTC(2026, 0, 1, 13, 30);
const STARTED_AT_ISO: string = composeScenarioInstant(STARTED_AT_MS, 0);

// The stem row ids are minted from; `composeScriptBeats` completes it with the beat's position.
const EVENT_ID_STEM = "019b7a33-3300-7e00-8110-e5e0c335";

const APPROVAL_REQUEST_SCRIPT: readonly ScriptEntry[] = [
  {
    atMs: 0,
    kind: "session.created",
    actorId: USER_YOU,
    payload: composeSessionCreatedPayload({
      sessionId: SESSION_ID,
      shape: "project",
      openedBy: USER_YOU,
      lead: {
        agentId: AGENT_IMPLEMENTER,
        name: "Implementer",
        driverName: "claude",
        modelId: "claude-sonnet-5",
      },
      createdAt: STARTED_AT_ISO,
    }),
  },
  // The run every request below was raised by. The execution posture is stamped only on
  // `run.running`, where the workspace root and effective posture are final.
  {
    atMs: 120,
    kind: "run.running",
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      runVersion: 2,
      previousState: "starting",
      newState: "running",
      executionPosture: {
        mode: "ask",
        credentialPolicyRef: "policy://workspace",
        writableRoots: ["/Users/dev/code/ai-sidekicks"],
      },
    },
  },
  {
    atMs: 200,
    kind: "approval.requested",
    actorId: AGENT_IMPLEMENTER,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      approvalRequestId: APPROVAL_RESOLVED,
      category: "tool_execution",
      scope: "run",
      requestedBy: AGENT_IMPLEMENTER,
      resourceDescriptor: { command: "pnpm --filter @ai-sidekicks/desktop run build" },
    },
  },
  // A resolution carries the scope that took effect (never broader than requested), the device
  // that answered and the id the answering client minted.
  {
    atMs: 420,
    kind: "approval.approved",
    actorId: USER_YOU,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      approvalRequestId: APPROVAL_RESOLVED,
      category: "tool_execution",
      scope: "run",
      effectiveScope: "run",
      deviceId: ANSWERING_DEVICE_ID,
      clientResolutionId: "019b7a33-3300-7c01-8110-d1a4c1150531",
    },
  },
  {
    atMs: 600,
    kind: "approval.requested",
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
  {
    atMs: 900,
    kind: "approval.requested",
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
    },
  },
  // The request that arrived as a provider permission ask: `askId` reaches the app on this
  // event and on no read, so the pane's framing comes from the event.
  {
    atMs: 1_100,
    kind: "approval.requested",
    actorId: AGENT_IMPLEMENTER,
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      approvalRequestId: APPROVAL_PENDING_ASK,
      askId: PERMISSION_ASK_ID,
      category: "tool_execution",
      scope: "run",
      requestedBy: AGENT_IMPLEMENTER,
      resourceDescriptor: {
        command: "git push --force origin feature/rebased",
        branch: "feature/rebased",
      },
    },
  },
];

/** One approved and three waiting approval requests raised by one agent in one run. */
export const APPROVAL_REQUEST_SCENARIO: Scenario = {
  id: "approval-request",
  label: "A decision waiting",
  purpose:
    "Three requests waiting, one of them a provider permission ask, beside one that is " +
    "already approved, so a view that lists the waiting ones can be held to leaving the " +
    "approved one out.",
  sessionId: SESSION_ID,
  startedAtIso: STARTED_AT_ISO,
  beats: composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EVENT_ID_STEM,
    startedAtMs: STARTED_AT_MS,
    entries: APPROVAL_REQUEST_SCRIPT,
  }),
  replies: [],
};
