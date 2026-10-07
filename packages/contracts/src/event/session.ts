// The strict session event parser: one arm per registered payload variant, discriminated on `type`.
// Every type in the closed `SessionEventType` set is registered, but only some have a payload
// variant.

import { z } from "zod";
// None of the payload files imported below imports this file, directly or through another module:
// such a cycle would leave their eagerly built Zod schemas undefined at import.
import {
  AgentProviderBindingChangeFailedPayloadSchema,
  AgentProviderBindingChangedPayloadSchema,
} from "../agent/provider-binding.js";
import {
  ApprovalCanceledPayloadSchema,
  ApprovalDenialOverriddenPayloadSchema,
  ApprovalRememberedPayloadSchema,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalReviewerDeniedPayloadSchema,
  ApprovalRuleRevokedPayloadSchema,
} from "../approval.js";
import { ArtifactPublicationPayloadSchema } from "../artifacts/publication.js";
import { CloudTaskUpdatedPayloadSchema } from "../cloud.js";
import { CommandEndedPayloadSchema } from "../command.js";
import {
  BackupCompletedPayloadSchema,
  BackupFailedPayloadSchema,
  BackupRestoredPayloadSchema,
} from "../daemon/backup.js";
import {
  RecoveryAttemptedPayloadSchema,
  RecoveryFailedPayloadSchema,
  RecoverySucceededPayloadSchema,
} from "../daemon/recovery.js";
import {
  EventCompactedPayloadSchema,
  UsageModelReroutedPayloadSchema,
  assistantMessagePayloadSchema,
  assistantThinkingUpdatePayloadSchema,
  buildMachineContentDescriptorShape,
  toolErrorPayloadSchema,
  toolInvokedPayloadSchema,
  toolResultPayloadSchema,
} from "./declared-variants.js";
import { buildCommonShape, withEpochStamp, type EventCategory } from "./envelope.js";
import type { SessionEventType } from "./registry.js";
import type {
  ApprovalReviewerDeniedEvent,
  CommandEndedEvent,
  SessionEvent,
} from "./variant-types.js";
import { GitSettledPayloadSchema } from "../gitflow/local.js";
import { McpServerOauthCompletedPayloadSchema } from "../mcp/governance.js";
import {
  PlanAcceptedPayloadSchema,
  PlanHandedOffPayloadSchema,
  PlanProposedPayloadSchema,
} from "../plan.js";
import { OrchestrationRejectedPayloadSchema } from "../orchestration.js";
import { PtyControlChangedPayloadSchema } from "../pty.js";
import { QuestionAskedPayloadSchema } from "../question.js";
import { RelayPinRefusedPayloadSchema } from "../relay.js";
import {
  RepoMountHealthChangedPayloadSchema,
  RepoWorkspaceLifecyclePayloadSchema,
} from "../repo/mount.js";
import {
  RunRecoveryResolvedPayloadSchema,
  RunRecoveryStepsAddedPayloadSchema,
} from "../run/control.js";
import {
  RunRefusalChoiceRequestedPayloadSchema,
  RunRefusalChoiceResolvedPayloadSchema,
  RunUsageCreditsChoiceRequestedPayloadSchema,
  RunUsageCreditsChoiceResolvedPayloadSchema,
} from "../run/provider-choice.js";
import { UserMessagePayloadSchema } from "../run/queue.js";
import { RunQueuedPayloadSchema } from "../run/queued.js";
import {
  INTERVENTION_EVENT_PAYLOAD_SCHEMAS,
  RUN_STATE_CHANGE_PAYLOAD_SCHEMAS,
  type RunStateChangeState,
} from "../run/events.js";
import type { InterventionState } from "../run/control.js";
import {
  ModerationReviewFlaggedPayloadSchema,
  RunStepLimitReachedPayloadSchema,
  RunTokenLimitReachedPayloadSchema,
  SessionNoticePayloadSchema,
  SessionSideQuestionAnsweredPayloadSchema,
  SessionSpendLimitReachedPayloadSchema,
} from "../session/controls/events.js";
import { SessionConvertedPayloadSchema } from "../session/convert.js";
import {
  SessionCreatedPayloadSchema,
  SessionLifecycleChangePayloadSchema,
  SessionAdvisorChangedPayloadSchema,
  SessionMarkChangePayloadSchema,
  SessionRenamedPayloadSchema,
} from "../session/events.js";
import {
  SessionGoalClearedPayloadSchema,
  SessionGoalUpdatedPayloadSchema,
} from "../session/goal.js";
import { SessionRestoreFinishedPayloadSchema } from "../session/restore.js";
import {
  WorkflowCanceledPayloadSchema,
  WorkflowResultsPostedPayloadSchema,
  WorkflowResumedPayloadSchema,
  WorkflowStartedPayloadSchema,
} from "../workflow/run/control.js";
import {
  WorkflowGateResolvedPayloadSchema,
  WorkflowPhaseSuspendedPayloadSchema,
  WorkflowStepCanceledPayloadSchema,
  WorkflowStepFailedPayloadSchema,
  WorkflowStepFinishedPayloadSchema,
  WorkflowStepSkippedPayloadSchema,
  WorkflowStepStartedPayloadSchema,
} from "../workflow/run/step/events.js";
import {
  SessionBranchChangedPayloadSchema,
  SessionSweptToRepoRootPayloadSchema,
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
} from "../worktree/events.js";
import { WorktreeLifecyclePayloadSchema } from "../worktree/lifecycle.js";

// The `satisfies` check makes a missing, unregistered or duplicate type a compile error.
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
  "run.stopped": "run_lifecycle",
  "run.failed": "run_lifecycle",
  "run.rolled_back": "run_lifecycle",
  "run.provider_initialized": "run_lifecycle",
  "run.turn_started": "run_lifecycle",
  "run.worker_shutdown": "run_lifecycle",
  "run.step_limit_reached": "run_lifecycle",
  "run.token_limit_reached": "run_lifecycle",
  "run.recovery_steps_added": "run_lifecycle",
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
  "intervention.failed": "interactive_request",
  "user.message": "interactive_request",
  "question.asked": "interactive_request",
  // artifact_publication
  "artifact.published": "artifact_publication",
  "artifact.superseded": "artifact_publication",
  "git.settled": "artifact_publication",
  // session_lifecycle
  "session.created": "session_lifecycle",
  "session.activated": "session_lifecycle",
  "session.archived": "session_lifecycle",
  "session.reactivated": "session_lifecycle",
  "session.closed": "session_lifecycle",
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
  "session.spend_limit_reached": "session_lifecycle",
  "session.restore_finished": "session_lifecycle",
  "session.advisor_changed": "session_lifecycle",
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
  "repo.mount_health_changed": "session_lifecycle",
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
  "usage.rate_limit_update": "usage_telemetry",
  "usage.api_retry": "usage_telemetry",
  "usage.context_compacted": "usage_telemetry",
  "usage.model_rerouted": "usage_telemetry",
  // recovery_events
  "recovery.attempted": "recovery_events",
  "recovery.succeeded": "recovery_events",
  "recovery.failed": "recovery_events",
  // security_events
  "relay.pin_refused": "security_events",
  // event_maintenance
  "event.compacted": "event_maintenance",
  "backup.completed": "event_maintenance",
  "backup.failed": "event_maintenance",
  "backup.restored": "event_maintenance",
  // orchestration_admission
  "orchestration.rejected": "orchestration_admission",
  // mcp_governance
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
 * Each registered wire type's category. A `ReadonlyMap`, not an object, so an untrusted
 * `.get(type)` read before parsing cannot walk the prototype chain to `__proto__` or `constructor`.
 */
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  // Sound by the `satisfies` check above: the record's keys are exactly the `SessionEventType`
  // literals.
  Object.entries(SESSION_EVENT_CATEGORY_RECORD) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// Builds one union arm. It is not exported, so its inferred return type keeps the literal `type`
// the discriminated union dispatches on; the category comes from the record above, so an arm filed
// under another category is a compile error.

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

// `withEpochStamp` takes a strict ZodObject, but the `z.ZodType<T>` annotation erases its object
// methods; it is a strict object at runtime, so the cast restores them for the call.
const commandEndedVariantPayloadSchema = withEpochStamp(
  CommandEndedPayloadSchema as unknown as z.ZodObject<Record<never, never>, z.core.$strict>,
) as unknown as z.ZodType<CommandEndedEvent["payload"]>;

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
const userMessageVariantSchema = buildSessionEventVariantSchema(
  "user.message",
  "interactive_request",
  UserMessagePayloadSchema,
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
const sessionSpendLimitReachedVariantSchema = buildSessionEventVariantSchema(
  "session.spend_limit_reached",
  "session_lifecycle",
  SessionSpendLimitReachedPayloadSchema,
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
const sessionActivatedVariantSchema = buildSessionEventVariantSchema(
  "session.activated",
  "session_lifecycle",
  SessionLifecycleChangePayloadSchema,
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
  UsageModelReroutedPayloadSchema,
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
// The `z.ZodType<T>` annotation erases the `.extend()` the payload needs; it is a strict object at
// runtime, so the cast restores it for the call.
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
const runTokenLimitReachedVariantSchema = buildSessionEventVariantSchema(
  "run.token_limit_reached",
  "run_lifecycle",
  RunTokenLimitReachedPayloadSchema,
);
const runRecoveryResolvedVariantSchema = buildSessionEventVariantSchema(
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayloadSchema,
);
const runRecoveryStepsAddedVariantSchema = buildSessionEventVariantSchema(
  "run.recovery_steps_added",
  "run_lifecycle",
  RunRecoveryStepsAddedPayloadSchema,
);
const sessionAdvisorChangedVariantSchema = buildSessionEventVariantSchema(
  "session.advisor_changed",
  "session_lifecycle",
  SessionAdvisorChangedPayloadSchema,
);
const repoMountHealthChangedVariantSchema = buildSessionEventVariantSchema(
  "repo.mount_health_changed",
  "session_lifecycle",
  RepoMountHealthChangedPayloadSchema,
);
const orchestrationRejectedVariantSchema = buildSessionEventVariantSchema(
  "orchestration.rejected",
  "orchestration_admission",
  OrchestrationRejectedPayloadSchema,
);
const artifactPublishedVariantSchema = buildSessionEventVariantSchema(
  "artifact.published",
  "artifact_publication",
  ArtifactPublicationPayloadSchema,
);
const artifactSupersededVariantSchema = buildSessionEventVariantSchema(
  "artifact.superseded",
  "artifact_publication",
  ArtifactPublicationPayloadSchema,
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
const workflowPhaseSuspendedVariantSchema = buildSessionEventVariantSchema(
  "workflow.phase_suspended",
  "workflow_phase_lifecycle",
  WorkflowPhaseSuspendedPayloadSchema,
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
const recoveryAttemptedVariantSchema = buildSessionEventVariantSchema(
  "recovery.attempted",
  "recovery_events",
  RecoveryAttemptedPayloadSchema,
);
const recoverySucceededVariantSchema = buildSessionEventVariantSchema(
  "recovery.succeeded",
  "recovery_events",
  RecoverySucceededPayloadSchema,
);
const recoveryFailedVariantSchema = buildSessionEventVariantSchema(
  "recovery.failed",
  "recovery_events",
  RecoveryFailedPayloadSchema,
);

// A run state change and an intervention event each take their payload from their own state.
const buildRunStateChangeVariantSchema = <TState extends RunStateChangeState>(state: TState) =>
  buildSessionEventVariantSchema(
    `run.${state}`,
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS[state],
  );
const buildInterventionVariantSchema = <TState extends InterventionState>(state: TState) =>
  buildSessionEventVariantSchema(
    `intervention.${state}`,
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS[state],
  );

// One arm per registered payload variant. The parser and the type list below both read it, so
// the two cannot disagree.
const SESSION_EVENT_VARIANT_SCHEMAS = [
  buildSessionEventVariantSchema(
    "session.created",
    "session_lifecycle",
    SessionCreatedPayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "workspace.preparing",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "workspace.ready",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "workspace.stale",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "workspace.archived",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "worktree.created",
    "session_lifecycle",
    WorktreeCreatedPayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "worktree.ready",
    "session_lifecycle",
    WorktreeLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "worktree.dirty",
    "session_lifecycle",
    WorktreeLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "worktree.merged",
    "session_lifecycle",
    WorktreeLifecyclePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "worktree.retired",
    "session_lifecycle",
    WorktreeRetiredPayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "event.compacted",
    "event_maintenance",
    EventCompactedPayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "assistant.message",
    "assistant_output",
    assistantMessagePayloadSchema,
  ),
  buildSessionEventVariantSchema(
    "assistant.thinking_update",
    "assistant_output",
    assistantThinkingUpdatePayloadSchema,
  ),
  buildSessionEventVariantSchema("tool.invoked", "tool_activity", toolInvokedPayloadSchema),
  buildSessionEventVariantSchema("tool.result", "tool_activity", toolResultPayloadSchema),
  buildSessionEventVariantSchema("tool.error", "tool_activity", toolErrorPayloadSchema),
  approvalRejectedVariantSchema,
  approvalCanceledVariantSchema,
  approvalRememberedVariantSchema,
  approvalRuleRevokedVariantSchema,
  moderationReviewFlaggedVariantSchema,
  planProposedVariantSchema,
  planAcceptedVariantSchema,
  planHandedOffVariantSchema,
  questionAskedVariantSchema,
  userMessageVariantSchema,
  mcpServerOauthCompletedVariantSchema,
  cloudTaskUpdatedVariantSchema,
  sessionRestoreFinishedVariantSchema,
  sessionGoalClearedVariantSchema,
  sessionNoticeVariantSchema,
  sessionSideQuestionAnsweredVariantSchema,
  sessionSpendLimitReachedVariantSchema,
  gitSettledVariantSchema,
  relayPinRefusedVariantSchema,
  commandEndedVariantSchema,
  usageModelReroutedVariantSchema,
  sessionActivatedVariantSchema,
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
  runTokenLimitReachedVariantSchema,
  runRecoveryResolvedVariantSchema,
  runRecoveryStepsAddedVariantSchema,
  sessionAdvisorChangedVariantSchema,
  repoMountHealthChangedVariantSchema,
  orchestrationRejectedVariantSchema,
  artifactPublishedVariantSchema,
  artifactSupersededVariantSchema,
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
  workflowPhaseSuspendedVariantSchema,
  workflowStepStartedVariantSchema,
  workflowStepFinishedVariantSchema,
  workflowStepFailedVariantSchema,
  workflowStepCanceledVariantSchema,
  workflowStepSkippedVariantSchema,
  workflowGateResolvedVariantSchema,
  backupCompletedVariantSchema,
  backupFailedVariantSchema,
  backupRestoredVariantSchema,
  recoveryAttemptedVariantSchema,
  recoverySucceededVariantSchema,
  recoveryFailedVariantSchema,
  buildRunStateChangeVariantSchema("starting"),
  buildRunStateChangeVariantSchema("running"),
  buildRunStateChangeVariantSchema("waiting_for_approval"),
  buildRunStateChangeVariantSchema("waiting_for_input"),
  buildRunStateChangeVariantSchema("pausing"),
  buildRunStateChangeVariantSchema("paused"),
  buildRunStateChangeVariantSchema("completed"),
  buildRunStateChangeVariantSchema("interrupted"),
  buildRunStateChangeVariantSchema("stopped"),
  buildRunStateChangeVariantSchema("failed"),
  buildInterventionVariantSchema("requested"),
  buildInterventionVariantSchema("accepted"),
  buildInterventionVariantSchema("applied"),
  buildInterventionVariantSchema("rejected"),
  buildInterventionVariantSchema("degraded"),
  buildInterventionVariantSchema("expired"),
  buildInterventionVariantSchema("failed"),
] as const;

/**
 * Strict parser for {@link SessionEvent}: an unknown type or a category that does not match its
 * type fails to parse.
 */
export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion(
  "type",
  SESSION_EVENT_VARIANT_SCHEMAS,
);

/** The event types with a payload variant registered in {@link SessionEventSchema}. */
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = Object.freeze(
  SESSION_EVENT_VARIANT_SCHEMAS.map((variant) => variant.shape.type.value),
);

// Cross-file ID types (`SessionId`, `UserId`, ...) are not re-exported here: each is imported from
// the module that declares it, so it has one import path.
