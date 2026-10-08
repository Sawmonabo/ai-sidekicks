// Session events several contracts tests parse, kept as one body each so a payload change is
// made once, and a valid payload for each event type no other contracts test builds.

import { DAEMON_SCOPE_SENTINEL_SESSION_ID, type EventCategory } from "../envelope.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";

/** A session event as it crosses the wire, before a parse brands its ids. */
export interface WireSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  occurredAt: string;
  category: EventCategory;
  type: string;
  actor: string | null;
  version: string;
  payload: Record<string, unknown>;
}

/** A valid `session.created` event: the first row of a chat session. */
export function buildSessionCreatedEvent(): WireSessionEvent {
  return {
    id: "evt-0001",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: USER_ID,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
}

/** A valid `assistant.message` event in a run; its body lives apart from the payload. */
export function buildAssistantMessageEvent(): WireSessionEvent {
  return {
    id: "evt-3601",
    sessionId: SESSION_ID,
    sequence: 40,
    occurredAt: "2026-01-22T19:15:01.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: null,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      contentType: "text/markdown",
      contentLength: 4096,
    },
  };
}

/** A valid `event.compacted` event: one deletion that removed a range of one session's rows. */
export function buildEventCompactedEvent(): WireSessionEvent {
  return {
    id: "evt-0105",
    sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
    sequence: 105,
    occurredAt: "2026-01-22T19:14:40.000Z",
    category: "event_maintenance",
    type: "event.compacted",
    actor: null,
    version: "1.0",
    payload: {
      nodeId: "node-7f3a2c",
      operationId: "compact-2026-01-22-01",
      occurredAt: "2026-01-22T19:14:40.000Z",
      removedSessions: [{ sessionId: SESSION_ID, fromSeq: 1, toSeq: 4096 }],
    },
  };
}

/** A valid `assistant.thinking_update` event in a run; its body lives apart from the payload. */
export function buildAssistantThinkingUpdateEvent(): WireSessionEvent {
  return {
    id: "evt-3602",
    sessionId: SESSION_ID,
    sequence: 41,
    occurredAt: "2026-01-22T19:15:02.000Z",
    category: "assistant_output",
    type: "assistant.thinking_update",
    actor: null,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      contentLength: 128,
    },
  };
}

/** A valid tool row of `type` at `sequence`, whose stored body was cut to a prefix. */
export function buildToolActivityEvent(
  type: "tool.invoked" | "tool.result" | "tool.error",
  sequence: number,
): WireSessionEvent {
  return {
    id: `evt-36${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-01-22T19:15:03.000Z",
    category: "tool_activity",
    type,
    actor: null,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      toolName: "Bash",
      toolCallId: "call-0001",
      durationMs: 1200,
      contentLength: 262_145,
      contentTruncated: true,
    },
  };
}

// The ids and members the hand-built payloads below share.
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const APPROVAL_REQUEST_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";
const RULE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f21";
const PLAN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f22";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f23";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f24";
const WORKFLOW_RUN_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f25";
const DENIAL_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f26";
const OCCURRED_AT = "2026-01-22T19:16:00.000Z";
const STEP = {
  sessionId: SESSION_ID,
  workflowRunId: WORKFLOW_RUN_ID,
  nodeId: "review",
  executionIndex: 0,
  attempt: 1,
};
const WORKFLOW = {
  sessionId: SESSION_ID,
  workflowRunId: WORKFLOW_RUN_ID,
  definitionId: "wfd-1",
  workflowVersionId: "wfv-3",
};
const APPROVAL = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  approvalRequestId: APPROVAL_REQUEST_ID,
  category: "tool_execution",
  scope: "Bash(pnpm test)",
};
const RESOLVED = {
  ...APPROVAL,
  effectiveScope: "Bash(pnpm test)",
  deviceId: "desktop-1",
  clientResolutionId: "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f27",
};
const INLINE_REF = { kind: "inline", items: [] };

/**
 * A valid payload for each registered event type that no other contracts test builds, keyed by the
 * event type.
 */
export const SESSION_EVENT_PAYLOAD_SAMPLES: ReadonlyMap<
  string,
  Readonly<Record<string, unknown>>
> = new Map<string, Readonly<Record<string, unknown>>>([
  ["workspace.preparing", { sessionId: SESSION_ID, state: "preparing" }],
  ["workspace.ready", { sessionId: SESSION_ID, state: "ready" }],
  ["workspace.stale", { sessionId: SESSION_ID, state: "stale" }],
  ["workspace.archived", { sessionId: SESSION_ID, state: "archived" }],
  ["approval.rejected", RESOLVED],
  ["approval.canceled", APPROVAL],
  [
    "approval.remembered",
    {
      ...APPROVAL,
      nodeId: "node-7f3a2c",
      ruleId: RULE_ID,
      rememberedScope: { kind: "session", pattern: "Bash(pnpm test)", sense: "allow" },
    },
  ],
  [
    "approval.rule_revoked",
    {
      sessionId: SESSION_ID,
      category: "tool_execution",
      scope: "Bash(pnpm test)",
      ruleId: RULE_ID,
      invalidationTrigger: "explicit",
    },
  ],
  [
    "moderation.review_flagged",
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      eventId: "evt-0042",
      signal: "review_warning",
      text: "This request may need a closer look.",
    },
  ],
  [
    "plan.proposed",
    {
      planId: PLAN_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      title: "Add the login flow",
      text: "1. Add the route.\n2. Add the form.",
      stepCount: 2,
      fileCount: 3,
    },
  ],
  ["plan.accepted", { planId: PLAN_ID, sessionId: SESSION_ID }],
  [
    "plan.handed_off",
    {
      planId: PLAN_ID,
      sessionId: SESSION_ID,
      freshSessionId: "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f28",
    },
  ],
  [
    "user.message",
    {
      sessionId: SESSION_ID,
      actor: "660e8400-e29b-41d4-a716-446655440001",
      message: "Run the tests again.",
    },
  ],
  [
    "cloud.task_updated",
    {
      task: {
        kind: "task",
        taskId: "task-1",
        sessionId: SESSION_ID,
        provider: "claude",
        environment: "default",
        attempts: 1,
        bringBack: { outcome: "applied" },
        state: "pending",
      },
    },
  ],
  [
    "session.restore_finished",
    {
      sessionId: SESSION_ID,
      target: { kind: "message", anchorCursor: "seq-40" },
      result: { outcome: "restore-finished", requested: "conversation", restored: "conversation" },
    },
  ],
  ["session.goal_cleared", { sessionId: SESSION_ID, agentId: AGENT_ID }],
  [
    "session.notice",
    {
      sessionId: SESSION_ID,
      kind: "settings_ignored",
      provider: "codex",
      file: ".codex/config.toml",
      line: 12,
    },
  ],
  [
    "session.side_question_answered",
    {
      sessionId: SESSION_ID,
      sideQuestionId: "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f29",
      question: "Which test failed?",
      answer: "The login test.",
    },
  ],
  ["session.spend_limit_reached", { sessionId: SESSION_ID, spendLimitUsdMicros: 5_000_000 }],
  ["git.settled", { sessionId: SESSION_ID, cause: "committed", commitId: "3f".repeat(20) }],
  [
    "command.ended",
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      commandId: "command-1",
      ending: "finished",
      durationMs: 1200,
    },
  ],
  [
    "usage.model_rerouted",
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      fromModel: "opus",
      toModel: "sonnet",
      scope: "turn",
      cause: "model_unavailable",
    },
  ],
  [
    "session.activated",
    { sessionId: SESSION_ID, previousState: "provisioning", newState: "active" },
  ],
  ["session.archived", { sessionId: SESSION_ID, previousState: "active", newState: "archived" }],
  ["session.reactivated", { sessionId: SESSION_ID, previousState: "archived", newState: "active" }],
  ["session.closed", { sessionId: SESSION_ID, previousState: "active", newState: "closed" }],
  ["session.pinned", { sessionId: SESSION_ID, at: OCCURRED_AT }],
  ["session.unpinned", { sessionId: SESSION_ID, at: OCCURRED_AT }],
  ["session.muted", { sessionId: SESSION_ID, at: OCCURRED_AT }],
  ["session.unmuted", { sessionId: SESSION_ID, at: OCCURRED_AT }],
  [
    "session.converted",
    { sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID, copiedCount: 4, skippedCount: 0 },
  ],
  [
    "session.branch_changed",
    {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      worktreeId: WORKTREE_ID,
      branch: "fix/login",
      previousBranch: "main",
    },
  ],
  [
    "session.swept_to_repo_root",
    { sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID, worktreeId: WORKTREE_ID },
  ],
  ["approval.requested", { ...APPROVAL, requestedBy: "claude", resourceDescriptor: {} }],
  ["approval.approved", RESOLVED],
  [
    "approval.reviewer_denied",
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      denialId: DENIAL_ID,
      eventId: "evt-0043",
      reason: "The command deletes files outside the worktree.",
      overridable: true,
    },
  ],
  ["approval.denial_overridden", { sessionId: SESSION_ID, denialId: DENIAL_ID }],
  ["run.step_limit_reached", { sessionId: SESSION_ID, runId: RUN_ID, count: 50 }],
  ["run.token_limit_reached", { sessionId: SESSION_ID, runId: RUN_ID, tokenLimit: 200_000 }],
  ["run.recovery_resolved", { sessionId: SESSION_ID, runId: RUN_ID, choice: "keep_provider" }],
  [
    "run.recovery_steps_added",
    { sessionId: SESSION_ID, runId: RUN_ID, count: 2, provider: "claude" },
  ],
  ["session.advisor_changed", { sessionId: SESSION_ID, advisorModel: "opus", at: OCCURRED_AT }],
  [
    "repo.mount_health_changed",
    { repoMountId: REPO_MOUNT_ID, health: { status: "healthy", checkedAt: OCCURRED_AT } },
  ],
  [
    "artifact.published",
    {
      sessionId: SESSION_ID,
      artifactId: "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "published",
    },
  ],
  [
    "artifact.superseded",
    {
      sessionId: SESSION_ID,
      artifactId: "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "superseded",
    },
  ],
  [
    "run.refusal_choice_requested",
    { sessionId: SESSION_ID, runId: RUN_ID, refusedModel: "opus", fallbackModel: "sonnet" },
  ],
  [
    "run.refusal_choice_resolved",
    { sessionId: SESSION_ID, runId: RUN_ID, choice: "retry_fallback" },
  ],
  [
    "run.usage_credits_choice_requested",
    { sessionId: SESSION_ID, runId: RUN_ID, modelName: "opus", overagesEnabled: false },
  ],
  [
    "run.usage_credits_choice_resolved",
    { sessionId: SESSION_ID, runId: RUN_ID, choice: "switch_default" },
  ],
  ["session.renamed", { sessionId: SESSION_ID, name: "Fix the login flow", origin: "user" }],
  [
    "workflow.started",
    { ...WORKFLOW, mode: "manual", startedBy: { kind: "user", deviceId: "desktop-1" } },
  ],
  ["workflow.resumed", WORKFLOW],
  ["workflow.canceled", WORKFLOW],
  ["workflow.results_posted", { sessionId: SESSION_ID, workflowRunId: WORKFLOW_RUN_ID }],
  ["workflow.step_started", { ...STEP, inputRef: INLINE_REF }],
  ["workflow.step_finished", { ...STEP, outputRef: INLINE_REF, logRef: INLINE_REF }],
  ["workflow.step_failed", { ...STEP, error: { message: "The review step timed out." } }],
  ["workflow.step_canceled", STEP],
  ["workflow.step_skipped", { ...STEP, reason: "no-items" }],
  ["backup.completed", { backupId: "backup-2026-01-22", totalBytes: 1_048_576 }],
  ["backup.failed", { message: "The backup folder is not writable." }],
  ["backup.restored", { backupId: "backup-2026-01-22" }],
]);
