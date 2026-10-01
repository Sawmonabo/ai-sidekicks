// The event types for variants whose payload another contract declares, and the `SessionEvent`
// union of every registered variant.

import type {
  AgentProviderBindingChangeFailedPayload,
  AgentProviderBindingChangedPayload,
} from "./agent-provider-binding.js";
import type {
  ApprovalCanceledPayload,
  ApprovalDenialOverriddenPayload,
  ApprovalRememberedPayload,
  ApprovalRequestedPayload,
  ApprovalResolvedPayload,
  ApprovalReviewerDeniedPayload,
  ApprovalRuleRevokedPayload,
} from "./approval.js";
import type { CloudTaskUpdatedPayload } from "./cloud.js";
import type { CommandEndedPayload } from "./command.js";
import type {
  BackupCompletedPayload,
  BackupFailedPayload,
  BackupRestoredPayload,
} from "./daemon-backup.js";
import type {
  AssistantMessageEvent,
  AssistantThinkingUpdateEvent,
  EventCompactedEvent,
  MachineContentDescriptor,
  SessionCreatedEvent,
  ToolErrorEvent,
  ToolInvokedEvent,
  ToolResultEvent,
  WorkspaceArchivedEvent,
  WorkspacePreparingEvent,
  WorkspaceReadyEvent,
  WorkspaceStaleEvent,
  WorktreeCreatedEvent,
  WorktreeDirtyEvent,
  WorktreeMergedEvent,
  WorktreeReadyEvent,
  WorktreeRetiredEvent,
} from "./event-declared-variants.js";
import type {
  EventCategory,
  EventEnvelope,
  SourceEpoch,
  SourcePosition,
} from "./event-envelope.js";
import type { SessionEventType } from "./event-registry.js";
import type { GitSettledPayload } from "./gitflow/local.js";
import type {
  McpServerOauthCompletedPayload,
  McpServerStatusChangedPayload,
} from "./mcp-governance.js";
import type { PlanAcceptedPayload, PlanHandedOffPayload, PlanProposedPayload } from "./plan.js";
import type { RunId } from "./provider-driver.js";
import type { PtyControlChangedPayload } from "./pty.js";
import type { QuestionAskedPayload } from "./question.js";
import type { RelayPinRefusedPayload } from "./relay.js";
import type { RunRecoveryResolvedPayload } from "./run-control.js";
import type {
  RunRefusalChoiceRequestedPayload,
  RunRefusalChoiceResolvedPayload,
  RunUsageCreditsChoiceRequestedPayload,
  RunUsageCreditsChoiceResolvedPayload,
} from "./run-provider-choice.js";
import type { RunQueuedPayload } from "./run-queued.js";
import type {
  ModerationReviewFlaggedPayload,
  RunStepLimitReachedPayload,
  SessionNoticePayload,
  SessionSideQuestionAnsweredPayload,
} from "./session-controls.js";
import type { SessionConvertedPayload } from "./session-convert.js";
import type { SessionGoalClearedPayload, SessionGoalUpdatedPayload } from "./session-goal.js";
import type { SessionRestoreFinishedPayload } from "./session-restore.js";
import type {
  SessionId,
  SessionLifecycleChangePayload,
  SessionMarkChangePayload,
  SessionRenamedPayload,
} from "./session.js";
import type {
  WorkflowCanceledPayload,
  WorkflowResultsPostedPayload,
  WorkflowResumedPayload,
  WorkflowStartedPayload,
} from "./workflow-run-control.js";
import type {
  WorkflowGateResolvedPayload,
  WorkflowStepEventPayload,
  WorkflowStepFailedPayload,
  WorkflowStepFinishedPayload,
  WorkflowStepSkippedPayload,
  WorkflowStepStartedPayload,
} from "./workflow-run-step.js";
import type {
  SessionBranchChangedPayload,
  SessionSweptToRepoRootPayload,
} from "./worktree-events.js";

// Each payload below is declared beside the method or record that produces it and imported here:
// the emitter's contract authors the payload. `usage.model_rerouted` is declared here because no
// other contract states it.
//
// Only `command.ended` and `usage.model_rerouted` take the epoch stamp: they are the run-scoped
// members here, each with a required `runId`. The approval, session-lifecycle, interactive-request,
// security and mcp-governance variants sit outside the late-append window, and `git.settled`
// names a run on only some causes.

/**
 * A session event whose payload a contract of its own declares: the envelope with `type`,
 * `category` and `payload` narrowed to one variant. `payload` maps the payload's members into an
 * object type, because TypeScript gives the implicit index signature the envelope's record needs
 * to object types and never to interfaces, so an owning contract may declare its payload either
 * way.
 */
export interface SessionEventVariant<
  TType extends SessionEventType,
  TCategory extends EventCategory,
  TPayload extends object,
> extends EventEnvelope {
  type: TType;
  category: TCategory;
  payload: { [Member in keyof TPayload]: TPayload[Member] };
}

/** Emitted when an approval request is refused, and by whom. */
export type ApprovalRejectedEvent = SessionEventVariant<
  "approval.rejected",
  "approval_flow",
  ApprovalResolvedPayload
>;
/** Emitted when an ask ends with its run and can no longer be answered. */
export type ApprovalCanceledEvent = SessionEventVariant<
  "approval.canceled",
  "approval_flow",
  ApprovalCanceledPayload
>;
/** Emitted when an approval rule is remembered; the payload is the whole rule. */
export type ApprovalRememberedEvent = SessionEventVariant<
  "approval.remembered",
  "approval_flow",
  ApprovalRememberedPayload
>;
/** Emitted when a remembered approval rule is revoked. */
export type ApprovalRuleRevokedEvent = SessionEventVariant<
  "approval.rule_revoked",
  "approval_flow",
  ApprovalRuleRevokedPayload
>;
/** Emitted when Codex's own reviewer flags an item with a warning or a required review. */
export type ModerationReviewFlaggedEvent = SessionEventVariant<
  "moderation.review_flagged",
  "approval_flow",
  ModerationReviewFlaggedPayload
>;
/** Emitted when an agent proposes a plan; the payload is the record the screen renders. */
export type PlanProposedEvent = SessionEventVariant<
  "plan.proposed",
  "approval_flow",
  PlanProposedPayload
>;
/** Emitted when a proposed plan is accepted and is being built in its own session. */
export type PlanAcceptedEvent = SessionEventVariant<
  "plan.accepted",
  "approval_flow",
  PlanAcceptedPayload
>;
/** Emitted when a plan seeds a fresh session. */
export type PlanHandedOffEvent = SessionEventVariant<
  "plan.handed_off",
  "approval_flow",
  PlanHandedOffPayload
>;
/** Emitted when an agent, tool server or workflow step asks the person a question. */
export type QuestionAskedEvent = SessionEventVariant<
  "question.asked",
  "interactive_request",
  QuestionAskedPayload
>;
/** Emitted when an MCP server's connection status changes. */
export type McpServerStatusChangedEvent = SessionEventVariant<
  "mcp.server_status_changed",
  "mcp_governance",
  McpServerStatusChangedPayload
>;
/** Emitted when an MCP server sign-in ends, in success or failure. */
export type McpServerOauthCompletedEvent = SessionEventVariant<
  "mcp.server_oauth_completed",
  "mcp_governance",
  McpServerOauthCompletedPayload
>;
/** Emitted when a cloud task is sent, changes state or is brought back. */
export type CloudTaskUpdatedEvent = SessionEventVariant<
  "cloud.task_updated",
  "session_lifecycle",
  CloudTaskUpdatedPayload
>;
/** Emitted when an undo finishes, with what applied and what did not. */
export type SessionRestoreFinishedEvent = SessionEventVariant<
  "session.restore_finished",
  "session_lifecycle",
  SessionRestoreFinishedPayload
>;
/** Emitted when a session's goal is removed. */
export type SessionGoalClearedEvent = SessionEventVariant<
  "session.goal_cleared",
  "session_lifecycle",
  SessionGoalClearedPayload
>;
/** Emitted for a plain-sentence notice about the session, such as a warning from the provider. */
export type SessionNoticeEvent = SessionEventVariant<
  "session.notice",
  "session_lifecycle",
  SessionNoticePayload
>;
/** Emitted when a side question is answered; the aside never enters the conversation. */
export type SessionSideQuestionAnsweredEvent = SessionEventVariant<
  "session.side_question_answered",
  "session_lifecycle",
  SessionSideQuestionAnsweredPayload
>;
/** Emitted when a git act leaves or changes the session's branch. */
export type GitSettledEvent = SessionEventVariant<
  "git.settled",
  "artifact_publication",
  GitSettledPayload
>;
/** Emitted when the relay presents a key that does not match the pinned one. */
export type RelayPinRefusedEvent = SessionEventVariant<
  "relay.pin_refused",
  "security_events",
  RelayPinRefusedPayload
>;
/** Emitted when a command ends; it takes the epoch stamp. */
export type CommandEndedEvent = SessionEventVariant<
  "command.ended",
  "tool_activity",
  CommandEndedPayload & {
    sourceEpoch?: SourceEpoch | undefined;
    sourcePosition?: SourcePosition | undefined;
  }
>;

/**
 * `usage.model_rerouted`: the provider moved a turn onto another model and the
 * turn went on. `scope` says how long the switch holds — this turn, the rest
 * of the session, or only a subagent's, a side question's or a background
 * fork's response (`local`). `sentence` and `explanation` are the provider's
 * own words when it sends them; `safetyCategory` names the check's category
 * when the provider reports one.
 */
export type UsageModelReroutedPayload = {
  sessionId: SessionId;
  runId: RunId;
  agentId?: string | undefined;
  fromModel: string;
  toModel: string;
  scope: "turn" | "session" | "local";
  sentence?: string | undefined;
  explanation?: string | undefined;
  cause: "safety" | "model_unavailable" | "model_blocked" | "out_of_credits";
  safetyCategory?: string | undefined;
};
/** Emitted when the provider moves a turn onto another model; it takes the epoch stamp. */
export type UsageModelReroutedEvent = SessionEventVariant<
  "usage.model_rerouted",
  "usage_telemetry",
  UsageModelReroutedPayload & {
    sourceEpoch?: SourceEpoch | undefined;
    sourcePosition?: SourcePosition | undefined;
  }
>;
/** Emitted when a session is archived. */
export type SessionArchivedEvent = SessionEventVariant<
  "session.archived",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
/** Emitted when an archived session is reactivated. */
export type SessionReactivatedEvent = SessionEventVariant<
  "session.reactivated",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
/** Emitted when a session is closed. */
export type SessionClosedEvent = SessionEventVariant<
  "session.closed",
  "session_lifecycle",
  SessionLifecycleChangePayload
>;
/** Emitted when a session is pinned. */
export type SessionPinnedEvent = SessionEventVariant<
  "session.pinned",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a session is unpinned. */
export type SessionUnpinnedEvent = SessionEventVariant<
  "session.unpinned",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a session is muted. */
export type SessionMutedEvent = SessionEventVariant<
  "session.muted",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a session is unmuted. */
export type SessionUnmutedEvent = SessionEventVariant<
  "session.unmuted",
  "session_lifecycle",
  SessionMarkChangePayload
>;
/** Emitted when a chat is converted, with the outcome of the copy. */
export type SessionConvertedEvent = SessionEventVariant<
  "session.converted",
  "session_lifecycle",
  SessionConvertedPayload
>;
/** Emitted when the branch a session's folder is on changes outside the console. */
export type SessionBranchChangedEvent = SessionEventVariant<
  "session.branch_changed",
  "session_lifecycle",
  SessionBranchChangedPayload
>;
/** Emitted when a worktree removal moves a session back to the repository root. */
export type SessionSweptToRepoRootEvent = SessionEventVariant<
  "session.swept_to_repo_root",
  "session_lifecycle",
  SessionSweptToRepoRootPayload
>;
/** Emitted when an agent's provider binding is switched. */
export type AgentProviderBindingChangedEvent = SessionEventVariant<
  "agent.provider_binding_changed",
  "session_lifecycle",
  AgentProviderBindingChangedPayload
>;
/** Emitted when an accepted binding switch could not be applied. */
export type AgentProviderBindingChangeFailedEvent = SessionEventVariant<
  "agent.provider_binding_change_failed",
  "session_lifecycle",
  AgentProviderBindingChangeFailedPayload
>;
/** Emitted when an approval is requested, including a provider's permission ask. */
export type ApprovalRequestedEvent = SessionEventVariant<
  "approval.requested",
  "approval_flow",
  ApprovalRequestedPayload
>;
/** Emitted when an approval request is granted, and by whom. */
export type ApprovalApprovedEvent = SessionEventVariant<
  "approval.approved",
  "approval_flow",
  ApprovalResolvedPayload
>;
/**
 * `approval.reviewer_denied` carries the provider's own denial as its body, so its
 * payload takes the append path's content members beside the owner's.
 */
export type ApprovalReviewerDeniedEvent = SessionEventVariant<
  "approval.reviewer_denied",
  "approval_flow",
  ApprovalReviewerDeniedPayload & MachineContentDescriptor
>;
/** Emitted when the person allows a blocked action once. */
export type ApprovalDenialOverriddenEvent = SessionEventVariant<
  "approval.denial_overridden",
  "approval_flow",
  ApprovalDenialOverriddenPayload
>;
/** Emitted when a run is queued. */
export type RunQueuedEvent = SessionEventVariant<"run.queued", "run_lifecycle", RunQueuedPayload>;
/** Emitted when a turn reaches the step bound and ends there. */
export type RunStepLimitReachedEvent = SessionEventVariant<
  "run.step_limit_reached",
  "run_lifecycle",
  RunStepLimitReachedPayload
>;
/** Emitted when the person's choice settles a run's recovery question. */
export type RunRecoveryResolvedEvent = SessionEventVariant<
  "run.recovery_resolved",
  "run_lifecycle",
  RunRecoveryResolvedPayload
>;
/** Emitted when Claude Code refuses a turn, names a fallback model and asks to retry or edit. */
export type RunRefusalChoiceRequestedEvent = SessionEventVariant<
  "run.refusal_choice_requested",
  "run_lifecycle",
  RunRefusalChoiceRequestedPayload
>;
/** Emitted when the first answer settles a refused turn's retry-or-edit choice. */
export type RunRefusalChoiceResolvedEvent = SessionEventVariant<
  "run.refusal_choice_resolved",
  "run_lifecycle",
  RunRefusalChoiceResolvedPayload
>;
/** Emitted when a Fable turn needs usage credits and Claude Code asks to switch or go on. */
export type RunUsageCreditsChoiceRequestedEvent = SessionEventVariant<
  "run.usage_credits_choice_requested",
  "run_lifecycle",
  RunUsageCreditsChoiceRequestedPayload
>;
/** Emitted when a Fable turn's switch-or-credits choice settles. */
export type RunUsageCreditsChoiceResolvedEvent = SessionEventVariant<
  "run.usage_credits_choice_resolved",
  "run_lifecycle",
  RunUsageCreditsChoiceResolvedPayload
>;
/** Emitted when a session's goal is set or changes status. */
export type SessionGoalUpdatedEvent = SessionEventVariant<
  "session.goal_updated",
  "session_lifecycle",
  SessionGoalUpdatedPayload
>;
/** Emitted when a session is renamed. */
export type SessionRenamedEvent = SessionEventVariant<
  "session.renamed",
  "session_lifecycle",
  SessionRenamedPayload
>;
/** Emitted when the holder of a shell changes. */
export type PtyControlChangedEvent = SessionEventVariant<
  "pty.control_changed",
  "session_lifecycle",
  PtyControlChangedPayload
>;
/** Emitted when a workflow run starts. */
export type WorkflowStartedEvent = SessionEventVariant<
  "workflow.started",
  "workflow_lifecycle",
  WorkflowStartedPayload
>;
/** Emitted when a workflow run resumes. */
export type WorkflowResumedEvent = SessionEventVariant<
  "workflow.resumed",
  "workflow_lifecycle",
  WorkflowResumedPayload
>;
/** Emitted when a workflow run is canceled. */
export type WorkflowCanceledEvent = SessionEventVariant<
  "workflow.canceled",
  "workflow_lifecycle",
  WorkflowCanceledPayload
>;
/** Emitted when a finished run's results land as a row in the asking session. */
export type WorkflowResultsPostedEvent = SessionEventVariant<
  "workflow.results_posted",
  "workflow_lifecycle",
  WorkflowResultsPostedPayload
>;
/** Emitted when a workflow step starts, with the input it ran on. */
export type WorkflowStepStartedEvent = SessionEventVariant<
  "workflow.step_started",
  "workflow_phase_lifecycle",
  WorkflowStepStartedPayload
>;
/** Emitted when a workflow step finishes, with its output and log. */
export type WorkflowStepFinishedEvent = SessionEventVariant<
  "workflow.step_finished",
  "workflow_phase_lifecycle",
  WorkflowStepFinishedPayload
>;
/** Emitted when a workflow step fails, with its error. */
export type WorkflowStepFailedEvent = SessionEventVariant<
  "workflow.step_failed",
  "workflow_phase_lifecycle",
  WorkflowStepFailedPayload
>;
/** Emitted when a running or waiting step ends because its run did. */
export type WorkflowStepCanceledEvent = SessionEventVariant<
  "workflow.step_canceled",
  "workflow_phase_lifecycle",
  WorkflowStepEventPayload
>;
/** Emitted when a workflow step is skipped. */
export type WorkflowStepSkippedEvent = SessionEventVariant<
  "workflow.step_skipped",
  "workflow_phase_lifecycle",
  WorkflowStepSkippedPayload
>;
/** Emitted when a workflow gate is answered. */
export type WorkflowGateResolvedEvent = SessionEventVariant<
  "workflow.gate_resolved",
  "workflow_gate_resolution",
  WorkflowGateResolvedPayload
>;
/** Emitted when a backup run writes a backup. */
export type BackupCompletedEvent = SessionEventVariant<
  "backup.completed",
  "event_maintenance",
  BackupCompletedPayload
>;
/** Emitted when a backup run does not finish. */
export type BackupFailedEvent = SessionEventVariant<
  "backup.failed",
  "event_maintenance",
  BackupFailedPayload
>;
/** Emitted when the service starts again from a backup. */
export type BackupRestoredEvent = SessionEventVariant<
  "backup.restored",
  "event_maintenance",
  BackupRestoredPayload
>;

/** Every session event with a registered payload variant, discriminated on `type`. */
export type SessionEvent =
  | SessionCreatedEvent
  | WorkspacePreparingEvent
  | WorkspaceReadyEvent
  | WorkspaceStaleEvent
  | WorkspaceArchivedEvent
  | WorktreeCreatedEvent
  | WorktreeReadyEvent
  | WorktreeDirtyEvent
  | WorktreeMergedEvent
  | WorktreeRetiredEvent
  | EventCompactedEvent
  | AssistantMessageEvent
  | AssistantThinkingUpdateEvent
  | ToolInvokedEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ApprovalRejectedEvent
  | ApprovalCanceledEvent
  | ApprovalRememberedEvent
  | ApprovalRuleRevokedEvent
  | ModerationReviewFlaggedEvent
  | PlanProposedEvent
  | PlanAcceptedEvent
  | PlanHandedOffEvent
  | QuestionAskedEvent
  | McpServerStatusChangedEvent
  | McpServerOauthCompletedEvent
  | CloudTaskUpdatedEvent
  | SessionRestoreFinishedEvent
  | SessionGoalClearedEvent
  | SessionNoticeEvent
  | SessionSideQuestionAnsweredEvent
  | GitSettledEvent
  | RelayPinRefusedEvent
  | CommandEndedEvent
  | UsageModelReroutedEvent
  | SessionArchivedEvent
  | SessionReactivatedEvent
  | SessionClosedEvent
  | SessionPinnedEvent
  | SessionUnpinnedEvent
  | SessionMutedEvent
  | SessionUnmutedEvent
  | SessionConvertedEvent
  | SessionBranchChangedEvent
  | SessionSweptToRepoRootEvent
  | AgentProviderBindingChangedEvent
  | AgentProviderBindingChangeFailedEvent
  | ApprovalRequestedEvent
  | ApprovalApprovedEvent
  | ApprovalReviewerDeniedEvent
  | ApprovalDenialOverriddenEvent
  | RunQueuedEvent
  | RunStepLimitReachedEvent
  | RunRecoveryResolvedEvent
  | RunRefusalChoiceRequestedEvent
  | RunRefusalChoiceResolvedEvent
  | RunUsageCreditsChoiceRequestedEvent
  | RunUsageCreditsChoiceResolvedEvent
  | SessionGoalUpdatedEvent
  | SessionRenamedEvent
  | PtyControlChangedEvent
  | WorkflowStartedEvent
  | WorkflowResumedEvent
  | WorkflowCanceledEvent
  | WorkflowResultsPostedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepFinishedEvent
  | WorkflowStepFailedEvent
  | WorkflowStepCanceledEvent
  | WorkflowStepSkippedEvent
  | WorkflowGateResolvedEvent
  | BackupCompletedEvent
  | BackupFailedEvent
  | BackupRestoredEvent;
