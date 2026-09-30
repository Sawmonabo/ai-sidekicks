// The strict session event parser: one arm per registered payload variant, discriminated on `type`.
//
// The set of event types (`SessionEventType`) is closed, but a payload variant is registered for
// only some of them: membership in the set is type registration, not payload support. Adding a
// variant later is additive.

import { z } from "zod";
// None of the payload files imported below imports this file, directly or through another module:
// such a cycle would leave their eagerly built Zod schemas undefined at import.
import {
  AgentProviderBindingChangeFailedPayloadSchema,
  AgentProviderBindingChangedPayloadSchema,
} from "./agent-provider-binding.js";
import {
  ApprovalCanceledPayloadSchema,
  ApprovalDenialOverriddenPayloadSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalReviewerDeniedPayloadSchema,
  ApprovalRuleRevokedPayloadSchema,
} from "./approval.js";
import { CloudTaskUpdatedPayloadSchema } from "./cloud.js";
import { CommandEndedPayloadSchema } from "./command.js";
import {
  BackupCompletedPayloadSchema,
  BackupFailedPayloadSchema,
  BackupRestoredPayloadSchema,
} from "./daemon-backup.js";
import { EVENT_FIELD_MAX_LEN } from "./event-core.js";
import {
  EventCompactedPayloadSchema,
  assistantMessagePayloadSchema,
  assistantThinkingUpdatePayloadSchema,
  buildMachineContentDescriptorShape,
  toolErrorPayloadSchema,
  toolInvokedPayloadSchema,
  toolResultPayloadSchema,
} from "./event-declared-variants.js";
import { buildCommonShape, withEpochStamp, type EventCategory } from "./event-envelope.js";
import type { SessionEventType } from "./event-registry.js";
import type {
  ApprovalReviewerDeniedEvent,
  CommandEndedEvent,
  SessionEvent,
} from "./event-variant-types.js";
import { GitSettledPayloadSchema } from "./gitflow/local.js";
import { uuidTextFormSchema } from "./internal/branded.js";
import {
  McpServerConfigChangedPayloadSchema,
  McpServerOauthCompletedPayloadSchema,
  McpServerStatusChangedPayloadSchema,
  McpServerTrustChangedPayloadSchema,
  McpToolOverrideChangedPayloadSchema,
} from "./mcp-governance.js";
import {
  PlanAcceptedPayloadSchema,
  PlanHandedOffPayloadSchema,
  PlanProposedPayloadSchema,
} from "./plan.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN, RunIdSchema } from "./provider-driver.js";
import { PtyControlChangedPayloadSchema } from "./pty.js";
import { QuestionAskedPayloadSchema } from "./question.js";
import { RelayPinRefusedPayloadSchema } from "./relay.js";
import { RepoWorkspaceLifecyclePayloadSchema } from "./repo.js";
import { RunRecoveryResolvedPayloadSchema } from "./run-control.js";
import {
  RunRefusalChoiceRequestedPayloadSchema,
  RunRefusalChoiceResolvedPayloadSchema,
  RunUsageCreditsChoiceRequestedPayloadSchema,
  RunUsageCreditsChoiceResolvedPayloadSchema,
} from "./run-provider-choice.js";
import { RunQueuedPayloadSchema } from "./run-queued.js";
import {
  ModerationReviewFlaggedPayloadSchema,
  RunStepLimitReachedPayloadSchema,
  SessionNoticePayloadSchema,
  SessionSideQuestionAnsweredPayloadSchema,
} from "./session-controls.js";
import { SessionConvertedPayloadSchema } from "./session-convert.js";
import { SessionCreatedPayloadSchema } from "./session-created.js";
import {
  SessionGoalClearedPayloadSchema,
  SessionGoalUpdatedPayloadSchema,
} from "./session-goal.js";
import { SessionRestoreFinishedPayloadSchema } from "./session-restore.js";
import {
  SessionIdSchema,
  SessionLifecycleChangePayloadSchema,
  SessionMarkChangePayloadSchema,
  SessionRenamedPayloadSchema,
  wireFreeFormString,
} from "./session.js";
import {
  WorkflowCanceledPayloadSchema,
  WorkflowResultsPostedPayloadSchema,
  WorkflowResumedPayloadSchema,
  WorkflowStartedPayloadSchema,
} from "./workflow-run-control.js";
import {
  WorkflowGateResolvedPayloadSchema,
  WorkflowStepCanceledPayloadSchema,
  WorkflowStepFailedPayloadSchema,
  WorkflowStepFinishedPayloadSchema,
  WorkflowStepSkippedPayloadSchema,
  WorkflowStepStartedPayloadSchema,
} from "./workflow-run-step.js";
import {
  SessionBranchChangedPayloadSchema,
  SessionSweptToRepoRootPayloadSchema,
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
} from "./worktree-events.js";
import { WorktreeLifecyclePayloadSchema } from "./worktree.js";

// Internal record behind the exported map. The `satisfies Record<SessionEventType,
// EventCategory>` check makes a missing, unregistered or duplicate key a compile error, so the
// registry cannot drift from `SessionEventType`.
const SESSION_EVENT_CATEGORY_RECORD = {
  // run_lifecycle
  "run.queued": "run_lifecycle",
  "run.starting": "run_lifecycle",
  "run.running": "run_lifecycle",
  "run.waiting_for_approval": "run_lifecycle",
  "run.waiting_for_input": "run_lifecycle",
  "run.pausing": "run_lifecycle",
  "run.paused": "run_lifecycle",
  "run.completed": "run_lifecycle",
  "run.interrupted": "run_lifecycle",
  "run.failed": "run_lifecycle",
  "run.rolled_back": "run_lifecycle",
  "run.provider_initialized": "run_lifecycle",
  "run.turn_started": "run_lifecycle",
  "run.worker_shutdown": "run_lifecycle",
  "run.step_limit_reached": "run_lifecycle",
  "run.recovery_resolved": "run_lifecycle",
  "run.refusal_choice_requested": "run_lifecycle",
  "run.refusal_choice_resolved": "run_lifecycle",
  "run.usage_credits_choice_requested": "run_lifecycle",
  "run.usage_credits_choice_resolved": "run_lifecycle",
  // assistant_output
  "assistant.message": "assistant_output",
  "assistant.thinking_update": "assistant_output",
  // tool_activity
  "tool.invoked": "tool_activity",
  "tool.result": "tool_activity",
  "tool.error": "tool_activity",
  "tool.replayed": "tool_activity",
  "tool.skipped_during_recovery": "tool_activity",
  "subagent.started": "tool_activity",
  "subagent.completed": "tool_activity",
  "command.ended": "tool_activity",
  // interactive_request
  "queue_item.created": "interactive_request",
  "queue_item.admitted": "interactive_request",
  "queue_item.superseded": "interactive_request",
  "queue_item.canceled": "interactive_request",
  "queue_item.not_delivered": "interactive_request",
  "intervention.requested": "interactive_request",
  "intervention.accepted": "interactive_request",
  "intervention.applied": "interactive_request",
  "intervention.rejected": "interactive_request",
  "intervention.degraded": "interactive_request",
  "intervention.expired": "interactive_request",
  "user.message": "interactive_request",
  "question.asked": "interactive_request",
  // artifact_publication
  "artifact.published": "artifact_publication",
  "artifact.visibility_updated": "artifact_publication",
  "artifact.superseded": "artifact_publication",
  "diff.created": "artifact_publication",
  "git.settled": "artifact_publication",
  // session_lifecycle
  "session.created": "session_lifecycle",
  "session.activated": "session_lifecycle",
  "session.archived": "session_lifecycle",
  "session.reactivated": "session_lifecycle",
  "session.closed": "session_lifecycle",
  "session.purge_requested": "session_lifecycle",
  "session.purged": "session_lifecycle",
  "session.goal_updated": "session_lifecycle",
  "session.goal_cleared": "session_lifecycle",
  "session.provider_status": "session_lifecycle",
  "session.notice": "session_lifecycle",
  "session.renamed": "session_lifecycle",
  "session.pinned": "session_lifecycle",
  "session.unpinned": "session_lifecycle",
  "session.muted": "session_lifecycle",
  "session.unmuted": "session_lifecycle",
  "session.converted": "session_lifecycle",
  "session.side_question_answered": "session_lifecycle",
  "session.restore_finished": "session_lifecycle",
  "agent.provider_binding_changed": "session_lifecycle",
  "agent.provider_binding_change_failed": "session_lifecycle",
  "workspace.preparing": "session_lifecycle",
  "workspace.ready": "session_lifecycle",
  "workspace.stale": "session_lifecycle",
  "workspace.archived": "session_lifecycle",
  "worktree.created": "session_lifecycle",
  "worktree.ready": "session_lifecycle",
  "worktree.dirty": "session_lifecycle",
  "worktree.merged": "session_lifecycle",
  "worktree.retired": "session_lifecycle",
  "session.branch_changed": "session_lifecycle",
  "session.swept_to_repo_root": "session_lifecycle",
  "pty.control_changed": "session_lifecycle",
  "cloud.task_updated": "session_lifecycle",
  // approval_flow
  "approval.requested": "approval_flow",
  "approval.approved": "approval_flow",
  "approval.rejected": "approval_flow",
  "approval.canceled": "approval_flow",
  "approval.remembered": "approval_flow",
  "approval.rule_revoked": "approval_flow",
  "approval.reviewer_denied": "approval_flow",
  "approval.denial_overridden": "approval_flow",
  "moderation.review_flagged": "approval_flow",
  "plan.proposed": "approval_flow",
  "plan.accepted": "approval_flow",
  "plan.handed_off": "approval_flow",
  // usage_telemetry
  "usage.token_count": "usage_telemetry",
  "usage.cost_update": "usage_telemetry",
  "usage.context_window_update": "usage_telemetry",
  "usage.budget_warning": "usage_telemetry",
  "usage.rate_limit_update": "usage_telemetry",
  "usage.api_retry": "usage_telemetry",
  "usage.context_compacted": "usage_telemetry",
  "usage.model_rerouted": "usage_telemetry",
  // runtime_node_lifecycle
  "session.clock_unsynced": "runtime_node_lifecycle",
  "session.clock_corrected": "runtime_node_lifecycle",
  // recovery_events
  "recovery.attempted": "recovery_events",
  "recovery.succeeded": "recovery_events",
  "recovery.failed": "recovery_events",
  // security_events
  "security.default.override": "security_events",
  "security.update.available": "security_events",
  "daemon.master_key_source": "security_events",
  "daemon.pii_split_ambiguous": "security_events",
  "relay.pin_refused": "security_events",
  // event_maintenance
  "event.compacted": "event_maintenance",
  "backup.completed": "event_maintenance",
  "backup.failed": "event_maintenance",
  "backup.restored": "event_maintenance",
  // orchestration_admission
  "orchestration.rejected": "orchestration_admission",
  // mcp_governance
  "mcp.server_status_changed": "mcp_governance",
  "mcp.server_config_changed": "mcp_governance",
  "mcp.server_trust_changed": "mcp_governance",
  "mcp.tool_override_changed": "mcp_governance",
  "mcp.server_oauth_completed": "mcp_governance",
  // workflow_lifecycle
  "workflow.created": "workflow_lifecycle",
  "workflow.started": "workflow_lifecycle",
  "workflow.gated": "workflow_lifecycle",
  "workflow.failed": "workflow_lifecycle",
  "workflow.completed": "workflow_lifecycle",
  "workflow.resumed": "workflow_lifecycle",
  "workflow.canceled": "workflow_lifecycle",
  "workflow.run_waiting": "workflow_lifecycle",
  "workflow.schedule_armed": "workflow_lifecycle",
  "workflow.schedule_fired": "workflow_lifecycle",
  "workflow.trigger_armed": "workflow_lifecycle",
  "workflow.trigger_fired": "workflow_lifecycle",
  "workflow.results_posted": "workflow_lifecycle",
  // workflow_phase_lifecycle
  "workflow.phase_admitted": "workflow_phase_lifecycle",
  "workflow.phase_waiting_on_pool": "workflow_phase_lifecycle",
  "workflow.phase_started": "workflow_phase_lifecycle",
  "workflow.phase_progressed": "workflow_phase_lifecycle",
  "workflow.phase_canceling": "workflow_phase_lifecycle",
  "workflow.phase_failed": "workflow_phase_lifecycle",
  "workflow.phase_retried": "workflow_phase_lifecycle",
  "workflow.phase_suspended": "workflow_phase_lifecycle",
  "workflow.phase_resumed": "workflow_phase_lifecycle",
  "workflow.phase_completed": "workflow_phase_lifecycle",
  "workflow.human_phase_claimed": "workflow_phase_lifecycle",
  "workflow.human_phase_escalated": "workflow_phase_lifecycle",
  "workflow.step_started": "workflow_phase_lifecycle",
  "workflow.step_finished": "workflow_phase_lifecycle",
  "workflow.step_failed": "workflow_phase_lifecycle",
  "workflow.step_canceled": "workflow_phase_lifecycle",
  "workflow.step_skipped": "workflow_phase_lifecycle",
  // workflow_parallel_coordination
  "workflow.parallel_join_cancellation": "workflow_parallel_coordination",
  // workflow_gate_resolution
  "workflow.gate_resolved": "workflow_gate_resolution",
} satisfies Record<SessionEventType, EventCategory>;

/**
 * Each registered wire type's category, for checking category/type consistency without
 * re-parsing. A `ReadonlyMap`, not an object, so an untrusted `.get(evt.type)` cannot walk the
 * prototype chain (`__proto__` and `constructor` would resolve to truthy non-categories). Readers
 * consult it before parsing through `SessionEventSchema`, so that immunity matters.
 */
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  // Sound by the `satisfies` check above: the record's keys are exactly the `SessionEventType`
  // literals.
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// Each arm is built once by `buildSessionEventVariantSchema` and registered in the union
// directly. The builder is not exported, so its inferred return type keeps the literal `type` that
// the discriminated union dispatches on, and it takes the category from the registry's entry for
// the type, so an arm filed under another category is a compile error. These variants export
// their event type and no standalone schema; `SessionEventSchema` is where they parse.

const buildSessionEventVariantSchema = <
  TType extends SessionEventType,
  TPayload extends z.ZodType<object>,
>(
  type: TType,
  category: (typeof SESSION_EVENT_CATEGORY_RECORD)[TType],
  payload: TPayload,
) =>
  z
    .object({
      ...buildCommonShape(),
      type: z.literal(type),
      category: z.literal(category),
      payload,
    })
    .strict();

// `withEpochStamp` takes a strict ZodObject, but the imported schema is annotated
// `z.ZodType<T>`, which erases that surface. It is a strict object at runtime, so the surface is
// re-widened for the call and the result annotated with the composed payload.
const commandEndedVariantPayloadSchema = withEpochStamp(
  CommandEndedPayloadSchema as unknown as z.ZodObject<Record<never, never>, z.core.$strict>,
) as unknown as z.ZodType<CommandEndedEvent["payload"]>;

const usageModelReroutedVariantPayloadSchema = withEpochStamp(
  z
    .object({
      sessionId: SessionIdSchema,
      runId: RunIdSchema,
      agentId: uuidTextFormSchema.optional(),
      fromModel: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UsageModelReroutedPayload.fromModel"),
      toModel: wireFreeFormString(EVENT_FIELD_MAX_LEN, "UsageModelReroutedPayload.toModel"),
      scope: z.enum(["turn", "session", "local"]),
      sentence: wireFreeFormString(
        DRIVER_FAILURE_DETAIL_MAX_LEN,
        "UsageModelReroutedPayload.sentence",
      ).optional(),
      explanation: wireFreeFormString(
        DRIVER_FAILURE_DETAIL_MAX_LEN,
        "UsageModelReroutedPayload.explanation",
      ).optional(),
      cause: z.enum(["safety", "model_unavailable", "model_blocked", "out_of_credits"]),
      safetyCategory: wireFreeFormString(
        EVENT_FIELD_MAX_LEN,
        "UsageModelReroutedPayload.safetyCategory",
      ).optional(),
    })
    .strict(),
);

const approvalRejectedVariantSchema = buildSessionEventVariantSchema(
  "approval.rejected",
  "approval_flow",
  ApprovalResolvedPayloadSchema,
);
const approvalCanceledVariantSchema = buildSessionEventVariantSchema(
  "approval.canceled",
  "approval_flow",
  ApprovalCanceledPayloadSchema,
);
const approvalRememberedVariantSchema = buildSessionEventVariantSchema(
  "approval.remembered",
  "approval_flow",
  ApprovalRememberedPayloadSchema,
);
const approvalRuleRevokedVariantSchema = buildSessionEventVariantSchema(
  "approval.rule_revoked",
  "approval_flow",
  ApprovalRuleRevokedPayloadSchema,
);
const moderationReviewFlaggedVariantSchema = buildSessionEventVariantSchema(
  "moderation.review_flagged",
  "approval_flow",
  ModerationReviewFlaggedPayloadSchema,
);
const planProposedVariantSchema = buildSessionEventVariantSchema(
  "plan.proposed",
  "approval_flow",
  PlanProposedPayloadSchema,
);
const planAcceptedVariantSchema = buildSessionEventVariantSchema(
  "plan.accepted",
  "approval_flow",
  PlanAcceptedPayloadSchema,
);
const planHandedOffVariantSchema = buildSessionEventVariantSchema(
  "plan.handed_off",
  "approval_flow",
  PlanHandedOffPayloadSchema,
);
const questionAskedVariantSchema = buildSessionEventVariantSchema(
  "question.asked",
  "interactive_request",
  QuestionAskedPayloadSchema,
);
const mcpServerStatusChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_status_changed",
  "mcp_governance",
  McpServerStatusChangedPayloadSchema,
);
const mcpServerConfigChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_config_changed",
  "mcp_governance",
  McpServerConfigChangedPayloadSchema,
);
const mcpServerTrustChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_trust_changed",
  "mcp_governance",
  McpServerTrustChangedPayloadSchema,
);
const mcpToolOverrideChangedVariantSchema = buildSessionEventVariantSchema(
  "mcp.tool_override_changed",
  "mcp_governance",
  McpToolOverrideChangedPayloadSchema,
);
const mcpServerOauthCompletedVariantSchema = buildSessionEventVariantSchema(
  "mcp.server_oauth_completed",
  "mcp_governance",
  McpServerOauthCompletedPayloadSchema,
);
const cloudTaskUpdatedVariantSchema = buildSessionEventVariantSchema(
  "cloud.task_updated",
  "session_lifecycle",
  CloudTaskUpdatedPayloadSchema,
);
const sessionRestoreFinishedVariantSchema = buildSessionEventVariantSchema(
  "session.restore_finished",
  "session_lifecycle",
  SessionRestoreFinishedPayloadSchema,
);
const sessionGoalClearedVariantSchema = buildSessionEventVariantSchema(
  "session.goal_cleared",
  "session_lifecycle",
  SessionGoalClearedPayloadSchema,
);
const sessionNoticeVariantSchema = buildSessionEventVariantSchema(
  "session.notice",
  "session_lifecycle",
  SessionNoticePayloadSchema,
);
const sessionSideQuestionAnsweredVariantSchema = buildSessionEventVariantSchema(
  "session.side_question_answered",
  "session_lifecycle",
  SessionSideQuestionAnsweredPayloadSchema,
);
const gitSettledVariantSchema = buildSessionEventVariantSchema(
  "git.settled",
  "artifact_publication",
  GitSettledPayloadSchema,
);
const relayPinRefusedVariantSchema = buildSessionEventVariantSchema(
  "relay.pin_refused",
  "security_events",
  RelayPinRefusedPayloadSchema,
);
const commandEndedVariantSchema = buildSessionEventVariantSchema(
  "command.ended",
  "tool_activity",
  commandEndedVariantPayloadSchema,
);
const sessionArchivedVariantSchema = buildSessionEventVariantSchema(
  "session.archived",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionReactivatedVariantSchema = buildSessionEventVariantSchema(
  "session.reactivated",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionClosedVariantSchema = buildSessionEventVariantSchema(
  "session.closed",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
);
const sessionPinnedVariantSchema = buildSessionEventVariantSchema(
  "session.pinned",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionUnpinnedVariantSchema = buildSessionEventVariantSchema(
  "session.unpinned",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionMutedVariantSchema = buildSessionEventVariantSchema(
  "session.muted",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const sessionUnmutedVariantSchema = buildSessionEventVariantSchema(
  "session.unmuted",
  "session_lifecycle",
  SessionMarkChangePayloadSchema,
);
const usageModelReroutedVariantSchema = buildSessionEventVariantSchema(
  "usage.model_rerouted",
  "usage_telemetry",
  usageModelReroutedVariantPayloadSchema,
);
const sessionConvertedVariantSchema = buildSessionEventVariantSchema(
  "session.converted",
  "session_lifecycle",
  SessionConvertedPayloadSchema,
);
const sessionBranchChangedVariantSchema = buildSessionEventVariantSchema(
  "session.branch_changed",
  "session_lifecycle",
  SessionBranchChangedPayloadSchema,
);
const sessionSweptToRepoRootVariantSchema = buildSessionEventVariantSchema(
  "session.swept_to_repo_root",
  "session_lifecycle",
  SessionSweptToRepoRootPayloadSchema,
);
const agentProviderBindingChangedVariantSchema = buildSessionEventVariantSchema(
  "agent.provider_binding_changed",
  "session_lifecycle",
  AgentProviderBindingChangedPayloadSchema,
);
const agentProviderBindingChangeFailedVariantSchema = buildSessionEventVariantSchema(
  "agent.provider_binding_change_failed",
  "session_lifecycle",
  AgentProviderBindingChangeFailedPayloadSchema,
);
const approvalRequestedVariantSchema = buildSessionEventVariantSchema(
  "approval.requested",
  "approval_flow",
  ApprovalRequestedPayloadSchema,
);
const approvalApprovedVariantSchema = buildSessionEventVariantSchema(
  "approval.approved",
  "approval_flow",
  ApprovalResolvedPayloadSchema,
);
// The owner's schema is annotated `z.ZodType<T>`, which erases the object surface `.extend()`
// needs. It is a strict object at runtime, so the surface is re-widened for the call and the
// result annotated with the composed payload.
const approvalReviewerDeniedVariantPayloadSchema = (
  ApprovalReviewerDeniedPayloadSchema as unknown as z.ZodObject<
    Record<never, never>,
    z.core.$strict
  >
).extend(buildMachineContentDescriptorShape()) as unknown as z.ZodType<
  ApprovalReviewerDeniedEvent["payload"]
>;
const approvalReviewerDeniedVariantSchema = buildSessionEventVariantSchema(
  "approval.reviewer_denied",
  "approval_flow",
  approvalReviewerDeniedVariantPayloadSchema,
);
const approvalDenialOverriddenVariantSchema = buildSessionEventVariantSchema(
  "approval.denial_overridden",
  "approval_flow",
  ApprovalDenialOverriddenPayloadSchema,
);
const runQueuedVariantSchema = buildSessionEventVariantSchema(
  "run.queued",
  "run_lifecycle",
  RunQueuedPayloadSchema,
);
const runStepLimitReachedVariantSchema = buildSessionEventVariantSchema(
  "run.step_limit_reached",
  "run_lifecycle",
  RunStepLimitReachedPayloadSchema,
);
const runRecoveryResolvedVariantSchema = buildSessionEventVariantSchema(
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayloadSchema,
);
const runRefusalChoiceRequestedVariantSchema = buildSessionEventVariantSchema(
  "run.refusal_choice_requested",
  "run_lifecycle",
  RunRefusalChoiceRequestedPayloadSchema,
);
const runRefusalChoiceResolvedVariantSchema = buildSessionEventVariantSchema(
  "run.refusal_choice_resolved",
  "run_lifecycle",
  RunRefusalChoiceResolvedPayloadSchema,
);
const runUsageCreditsChoiceRequestedVariantSchema = buildSessionEventVariantSchema(
  "run.usage_credits_choice_requested",
  "run_lifecycle",
  RunUsageCreditsChoiceRequestedPayloadSchema,
);
const runUsageCreditsChoiceResolvedVariantSchema = buildSessionEventVariantSchema(
  "run.usage_credits_choice_resolved",
  "run_lifecycle",
  RunUsageCreditsChoiceResolvedPayloadSchema,
);
const sessionGoalUpdatedVariantSchema = buildSessionEventVariantSchema(
  "session.goal_updated",
  "session_lifecycle",
  SessionGoalUpdatedPayloadSchema,
);
const sessionRenamedVariantSchema = buildSessionEventVariantSchema(
  "session.renamed",
  "session_lifecycle",
  SessionRenamedPayloadSchema,
);
const ptyControlChangedVariantSchema = buildSessionEventVariantSchema(
  "pty.control_changed",
  "session_lifecycle",
  PtyControlChangedPayloadSchema,
);
const workflowStartedVariantSchema = buildSessionEventVariantSchema(
  "workflow.started",
  "workflow_lifecycle",
  WorkflowStartedPayloadSchema,
);
const workflowResumedVariantSchema = buildSessionEventVariantSchema(
  "workflow.resumed",
  "workflow_lifecycle",
  WorkflowResumedPayloadSchema,
);
const workflowCanceledVariantSchema = buildSessionEventVariantSchema(
  "workflow.canceled",
  "workflow_lifecycle",
  WorkflowCanceledPayloadSchema,
);
const workflowResultsPostedVariantSchema = buildSessionEventVariantSchema(
  "workflow.results_posted",
  "workflow_lifecycle",
  WorkflowResultsPostedPayloadSchema,
);
const workflowStepStartedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_started",
  "workflow_phase_lifecycle",
  WorkflowStepStartedPayloadSchema,
);
const workflowStepFinishedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_finished",
  "workflow_phase_lifecycle",
  WorkflowStepFinishedPayloadSchema,
);
const workflowStepFailedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_failed",
  "workflow_phase_lifecycle",
  WorkflowStepFailedPayloadSchema,
);
const workflowStepCanceledVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_canceled",
  "workflow_phase_lifecycle",
  WorkflowStepCanceledPayloadSchema,
);
const workflowStepSkippedVariantSchema = buildSessionEventVariantSchema(
  "workflow.step_skipped",
  "workflow_phase_lifecycle",
  WorkflowStepSkippedPayloadSchema,
);
const workflowGateResolvedVariantSchema = buildSessionEventVariantSchema(
  "workflow.gate_resolved",
  "workflow_gate_resolution",
  WorkflowGateResolvedPayloadSchema,
);
const backupCompletedVariantSchema = buildSessionEventVariantSchema(
  "backup.completed",
  "event_maintenance",
  BackupCompletedPayloadSchema,
);
const backupFailedVariantSchema = buildSessionEventVariantSchema(
  "backup.failed",
  "event_maintenance",
  BackupFailedPayloadSchema,
);
const backupRestoredVariantSchema = buildSessionEventVariantSchema(
  "backup.restored",
  "event_maintenance",
  BackupRestoredPayloadSchema,
);

// `z.discriminatedUnion` needs literal-typed ZodObject variants, which gives O(1) parse dispatch
// and narrowed types where an event is used. The variant schemas are rebuilt here instead of
// reusing the exported `*EventSchema` values, because `z.ZodType<T>` erases the literal `type`
// the union discriminates on; this keeps the public API `isolatedDeclarations`-friendly. Payload
// schemas are shared, so payload shapes cannot drift between the two surfaces.

/**
 * Strict parser for {@link SessionEvent}: an unknown type or a category that does not match its
 * type fails to parse.
 */
export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion("type", [
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("session.created"),
      category: z.literal("session_lifecycle"),
      payload: SessionCreatedPayloadSchema,
    })
    .strict(),
  // The four workspace arms share repo.ts's payload schema; none takes the epoch stamp.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.preparing"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.ready"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.stale"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("workspace.archived"),
      category: z.literal("session_lifecycle"),
      payload: RepoWorkspaceLifecyclePayloadSchema,
    })
    .strict(),
  // The five worktree arms use the payload schemas of their `*EventSchema` exports; none takes
  // the epoch stamp. There is no `worktree.failed` arm.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.created"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeCreatedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.ready"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.dirty"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.merged"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeLifecyclePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("worktree.retired"),
      category: z.literal("session_lifecycle"),
      payload: WorktreeRetiredPayloadSchema,
    })
    .strict(),
  // The `event.compacted` arm shares the payload schema from `event-declared-variants.ts`, which
  // authors it because the daemon emits the row itself; it takes no epoch stamp.
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("event.compacted"),
      category: z.literal("event_maintenance"),
      payload: EventCompactedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("assistant.message"),
      category: z.literal("assistant_output"),
      payload: assistantMessagePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("assistant.thinking_update"),
      category: z.literal("assistant_output"),
      payload: assistantThinkingUpdatePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.invoked"),
      category: z.literal("tool_activity"),
      payload: toolInvokedPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.result"),
      category: z.literal("tool_activity"),
      payload: toolResultPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...buildCommonShape(),
      type: z.literal("tool.error"),
      category: z.literal("tool_activity"),
      payload: toolErrorPayloadSchema,
    })
    .strict(),
  // The arms built once by `buildSessionEventVariantSchema` above.
  approvalRejectedVariantSchema,
  approvalCanceledVariantSchema,
  approvalRememberedVariantSchema,
  approvalRuleRevokedVariantSchema,
  moderationReviewFlaggedVariantSchema,
  planProposedVariantSchema,
  planAcceptedVariantSchema,
  planHandedOffVariantSchema,
  questionAskedVariantSchema,
  mcpServerStatusChangedVariantSchema,
  mcpServerConfigChangedVariantSchema,
  mcpServerTrustChangedVariantSchema,
  mcpToolOverrideChangedVariantSchema,
  mcpServerOauthCompletedVariantSchema,
  cloudTaskUpdatedVariantSchema,
  sessionRestoreFinishedVariantSchema,
  sessionGoalClearedVariantSchema,
  sessionNoticeVariantSchema,
  sessionSideQuestionAnsweredVariantSchema,
  gitSettledVariantSchema,
  relayPinRefusedVariantSchema,
  commandEndedVariantSchema,
  usageModelReroutedVariantSchema,
  sessionArchivedVariantSchema,
  sessionReactivatedVariantSchema,
  sessionClosedVariantSchema,
  sessionPinnedVariantSchema,
  sessionUnpinnedVariantSchema,
  sessionMutedVariantSchema,
  sessionUnmutedVariantSchema,
  sessionConvertedVariantSchema,
  sessionBranchChangedVariantSchema,
  sessionSweptToRepoRootVariantSchema,
  agentProviderBindingChangedVariantSchema,
  agentProviderBindingChangeFailedVariantSchema,
  approvalRequestedVariantSchema,
  approvalApprovedVariantSchema,
  approvalReviewerDeniedVariantSchema,
  approvalDenialOverriddenVariantSchema,
  runQueuedVariantSchema,
  runStepLimitReachedVariantSchema,
  runRecoveryResolvedVariantSchema,
  runRefusalChoiceRequestedVariantSchema,
  runRefusalChoiceResolvedVariantSchema,
  runUsageCreditsChoiceRequestedVariantSchema,
  runUsageCreditsChoiceResolvedVariantSchema,
  sessionGoalUpdatedVariantSchema,
  sessionRenamedVariantSchema,
  ptyControlChangedVariantSchema,
  workflowStartedVariantSchema,
  workflowResumedVariantSchema,
  workflowCanceledVariantSchema,
  workflowResultsPostedVariantSchema,
  workflowStepStartedVariantSchema,
  workflowStepFinishedVariantSchema,
  workflowStepFailedVariantSchema,
  workflowStepCanceledVariantSchema,
  workflowStepSkippedVariantSchema,
  workflowGateResolvedVariantSchema,
  backupCompletedVariantSchema,
  backupFailedVariantSchema,
  backupRestoredVariantSchema,
]);

// Cross-file ID types (`SessionId`, `UserId`, ...) are not re-exported here: the package barrel
// already exports them from session.ts, and a second export would conflict.
