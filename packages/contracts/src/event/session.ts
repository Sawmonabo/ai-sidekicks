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
import { SESSION_EVENT_CATEGORY_RECORD } from "./type-categories.js";
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
import { RecoveryDamagedEventsSkippedPayloadSchema } from "../session/recovery.js";
import { SessionRestoreFinishedPayloadSchema } from "../session/restore.js";
import {
  WorkflowCanceledPayloadSchema,
  WorkflowResultsPostedPayloadSchema,
  WorkflowResumedPayloadSchema,
  WorkflowRunDeletedPayloadSchema,
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

// Checked both ways: a registered type with no category, a category outside the closed set, or
// a category for a type the closed list lacks is a compile error.
const SESSION_EVENT_CATEGORIES: Readonly<Record<SessionEventType, EventCategory>> &
  Readonly<Record<Exclude<keyof typeof SESSION_EVENT_CATEGORY_RECORD, SessionEventType>, never>> =
  SESSION_EVENT_CATEGORY_RECORD;

/**
 * Each registered wire type's category. A `ReadonlyMap`, not an object, so an untrusted
 * `.get(type)` read before parsing cannot walk the prototype chain to `__proto__` or `constructor`.
 */
export const SESSION_EVENT_CATEGORY_BY_TYPE: ReadonlyMap<SessionEventType, EventCategory> = new Map(
  // Sound by the check above: the record's keys are exactly the `SessionEventType` literals.
  Object.entries(SESSION_EVENT_CATEGORIES) as ReadonlyArray<[SessionEventType, EventCategory]>,
);

// Builds one union arm. It is not exported, so its inferred return type keeps the literal `type`
// the discriminated union dispatches on; the category comes from the category record, so an arm
// filed under another category is a compile error.

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
const workflowRunDeletedVariantSchema = buildSessionEventVariantSchema(
  "workflow.run_deleted",
  "workflow_lifecycle",
  WorkflowRunDeletedPayloadSchema,
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
const recoveryDamagedEventsSkippedVariantSchema = buildSessionEventVariantSchema(
  "recovery.damaged_events_skipped",
  "recovery_events",
  RecoveryDamagedEventsSkippedPayloadSchema,
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
  workflowRunDeletedVariantSchema,
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
  recoveryDamagedEventsSkippedVariantSchema,
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
