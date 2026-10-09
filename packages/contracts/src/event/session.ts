// The strict session event parser: one schema per registered payload variant, chosen by `type`.
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
  MACHINE_CONTENT_DESCRIPTOR_SHAPE,
  assistantOutputPayloadSchema,
  toolActivityPayloadSchema,
} from "./declared-variants.js";
import { EVENT_ENVELOPE_COMMON_SHAPE, withEpochStamp, type EventCategory } from "./envelope.js";
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
  RunProviderInitializedPayloadSchema,
  RunTurnStartedPayloadSchema,
  RunWorkerShutdownPayloadSchema,
} from "../run/events.js";
import { SubagentLifecyclePayloadSchema } from "../run/subagent.js";
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
  SessionOutputStyleChangedPayloadSchema,
  SessionProviderStatusPayloadSchema,
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

// `withEpochStamp` takes a strict ZodObject, but the `z.ZodType<T>` annotation erases its object
// methods; it is a strict object at runtime, so the cast restores them for the call.
const commandEndedVariantPayloadSchema = withEpochStamp(
  CommandEndedPayloadSchema as unknown as z.ZodObject<Record<never, never>, z.core.$strict>,
) as unknown as z.ZodType<CommandEndedEvent["payload"]>;

// The `z.ZodType<T>` annotation erases the `.extend()` the payload needs; it is a strict object at
// runtime, so the cast restores it for the call.
const approvalReviewerDeniedVariantPayloadSchema = (
  ApprovalReviewerDeniedPayloadSchema as unknown as z.ZodObject<
    Record<never, never>,
    z.core.$strict
  >
).extend(MACHINE_CONTENT_DESCRIPTOR_SHAPE) as unknown as z.ZodType<
  ApprovalReviewerDeniedEvent["payload"]
>;

/** One registered event type: its wire `type`, its category and its payload schema. */
interface SessionEventVariantRegistration {
  readonly type: SessionEventType;
  readonly category: EventCategory;
  readonly payload: z.ZodType<object>;
}

// Registers one event type. The parameter types are the compile-time check: the category must be
// the type's own in both the record above and `SessionEvent`, and the payload schema must produce
// that event's payload, so every arm built from a registration parses to a `SessionEvent`.
const registerSessionEventVariant = <TType extends SessionEvent["type"]>(
  type: TType,
  category: (typeof SESSION_EVENT_CATEGORY_RECORD)[TType] &
    Extract<SessionEvent, { type: TType }>["category"],
  payload: z.ZodType<Extract<SessionEvent, { type: TType }>["payload"]>,
): SessionEventVariantRegistration & { readonly type: TType } => ({ type, category, payload });

// One registration per event type with a payload variant. The parser and the type list below both
// read it, so the two cannot disagree.
const SESSION_EVENT_VARIANT_REGISTRATIONS = [
  registerSessionEventVariant("session.created", "session_lifecycle", SessionCreatedPayloadSchema),
  registerSessionEventVariant(
    "workspace.preparing",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "workspace.ready",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "workspace.stale",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "workspace.archived",
    "session_lifecycle",
    RepoWorkspaceLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "worktree.created",
    "session_lifecycle",
    WorktreeCreatedPayloadSchema,
  ),
  registerSessionEventVariant(
    "worktree.ready",
    "session_lifecycle",
    WorktreeLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "worktree.dirty",
    "session_lifecycle",
    WorktreeLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "worktree.merged",
    "session_lifecycle",
    WorktreeLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "worktree.retired",
    "session_lifecycle",
    WorktreeRetiredPayloadSchema,
  ),
  registerSessionEventVariant("event.compacted", "event_maintenance", EventCompactedPayloadSchema),
  registerSessionEventVariant(
    "assistant.message",
    "assistant_output",
    assistantOutputPayloadSchema,
  ),
  registerSessionEventVariant(
    "assistant.thinking_update",
    "assistant_output",
    assistantOutputPayloadSchema,
  ),
  registerSessionEventVariant("tool.invoked", "tool_activity", toolActivityPayloadSchema),
  registerSessionEventVariant("tool.result", "tool_activity", toolActivityPayloadSchema),
  registerSessionEventVariant("tool.error", "tool_activity", toolActivityPayloadSchema),
  registerSessionEventVariant(
    "subagent.started",
    "tool_activity",
    SubagentLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "subagent.completed",
    "tool_activity",
    SubagentLifecyclePayloadSchema,
  ),
  registerSessionEventVariant(
    "run.provider_initialized",
    "run_lifecycle",
    RunProviderInitializedPayloadSchema,
  ),
  registerSessionEventVariant("run.turn_started", "run_lifecycle", RunTurnStartedPayloadSchema),
  registerSessionEventVariant(
    "run.worker_shutdown",
    "run_lifecycle",
    RunWorkerShutdownPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.provider_status",
    "session_lifecycle",
    SessionProviderStatusPayloadSchema,
  ),
  registerSessionEventVariant("approval.rejected", "approval_flow", ApprovalResolvedPayloadSchema),
  registerSessionEventVariant("approval.canceled", "approval_flow", ApprovalCanceledPayloadSchema),
  registerSessionEventVariant(
    "approval.remembered",
    "approval_flow",
    ApprovalRememberedPayloadSchema,
  ),
  registerSessionEventVariant(
    "approval.rule_revoked",
    "approval_flow",
    ApprovalRuleRevokedPayloadSchema,
  ),
  registerSessionEventVariant(
    "moderation.review_flagged",
    "approval_flow",
    ModerationReviewFlaggedPayloadSchema,
  ),
  registerSessionEventVariant("plan.proposed", "approval_flow", PlanProposedPayloadSchema),
  registerSessionEventVariant("plan.accepted", "approval_flow", PlanAcceptedPayloadSchema),
  registerSessionEventVariant("plan.handed_off", "approval_flow", PlanHandedOffPayloadSchema),
  registerSessionEventVariant("question.asked", "interactive_request", QuestionAskedPayloadSchema),
  registerSessionEventVariant("user.message", "interactive_request", UserMessagePayloadSchema),
  registerSessionEventVariant(
    "mcp.server_oauth_completed",
    "mcp_governance",
    McpServerOauthCompletedPayloadSchema,
  ),
  registerSessionEventVariant(
    "cloud.task_updated",
    "session_lifecycle",
    CloudTaskUpdatedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.restore_finished",
    "session_lifecycle",
    SessionRestoreFinishedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.goal_cleared",
    "session_lifecycle",
    SessionGoalClearedPayloadSchema,
  ),
  registerSessionEventVariant("session.notice", "session_lifecycle", SessionNoticePayloadSchema),
  registerSessionEventVariant(
    "session.side_question_answered",
    "session_lifecycle",
    SessionSideQuestionAnsweredPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.spend_limit_reached",
    "session_lifecycle",
    SessionSpendLimitReachedPayloadSchema,
  ),
  registerSessionEventVariant("git.settled", "artifact_publication", GitSettledPayloadSchema),
  registerSessionEventVariant("relay.pin_refused", "security_events", RelayPinRefusedPayloadSchema),
  registerSessionEventVariant("command.ended", "tool_activity", commandEndedVariantPayloadSchema),
  registerSessionEventVariant(
    "usage.model_rerouted",
    "usage_telemetry",
    UsageModelReroutedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.activated",
    "session_lifecycle",
    SessionLifecycleChangePayloadSchema,
  ),
  registerSessionEventVariant(
    "session.archived",
    "session_lifecycle",
    SessionLifecycleChangePayloadSchema,
  ),
  registerSessionEventVariant(
    "session.reactivated",
    "session_lifecycle",
    SessionLifecycleChangePayloadSchema,
  ),
  registerSessionEventVariant(
    "session.closed",
    "session_lifecycle",
    SessionLifecycleChangePayloadSchema,
  ),
  registerSessionEventVariant(
    "session.pinned",
    "session_lifecycle",
    SessionMarkChangePayloadSchema,
  ),
  registerSessionEventVariant(
    "session.unpinned",
    "session_lifecycle",
    SessionMarkChangePayloadSchema,
  ),
  registerSessionEventVariant("session.muted", "session_lifecycle", SessionMarkChangePayloadSchema),
  registerSessionEventVariant(
    "session.unmuted",
    "session_lifecycle",
    SessionMarkChangePayloadSchema,
  ),
  registerSessionEventVariant(
    "session.converted",
    "session_lifecycle",
    SessionConvertedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.branch_changed",
    "session_lifecycle",
    SessionBranchChangedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.swept_to_repo_root",
    "session_lifecycle",
    SessionSweptToRepoRootPayloadSchema,
  ),
  registerSessionEventVariant(
    "agent.provider_binding_changed",
    "session_lifecycle",
    AgentProviderBindingChangedPayloadSchema,
  ),
  registerSessionEventVariant(
    "agent.provider_binding_change_failed",
    "session_lifecycle",
    AgentProviderBindingChangeFailedPayloadSchema,
  ),
  registerSessionEventVariant(
    "approval.requested",
    "approval_flow",
    ApprovalRequestedPayloadSchema,
  ),
  registerSessionEventVariant("approval.approved", "approval_flow", ApprovalResolvedPayloadSchema),
  registerSessionEventVariant(
    "approval.reviewer_denied",
    "approval_flow",
    approvalReviewerDeniedVariantPayloadSchema,
  ),
  registerSessionEventVariant(
    "approval.denial_overridden",
    "approval_flow",
    ApprovalDenialOverriddenPayloadSchema,
  ),
  registerSessionEventVariant("run.queued", "run_lifecycle", RunQueuedPayloadSchema),
  registerSessionEventVariant(
    "run.step_limit_reached",
    "run_lifecycle",
    RunStepLimitReachedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.token_limit_reached",
    "run_lifecycle",
    RunTokenLimitReachedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.recovery_resolved",
    "run_lifecycle",
    RunRecoveryResolvedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.recovery_steps_added",
    "run_lifecycle",
    RunRecoveryStepsAddedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.advisor_changed",
    "session_lifecycle",
    SessionAdvisorChangedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.output_style_changed",
    "session_lifecycle",
    SessionOutputStyleChangedPayloadSchema,
  ),
  registerSessionEventVariant(
    "repo.mount_health_changed",
    "session_lifecycle",
    RepoMountHealthChangedPayloadSchema,
  ),
  registerSessionEventVariant(
    "orchestration.rejected",
    "orchestration_admission",
    OrchestrationRejectedPayloadSchema,
  ),
  registerSessionEventVariant(
    "artifact.published",
    "artifact_publication",
    ArtifactPublicationPayloadSchema,
  ),
  registerSessionEventVariant(
    "artifact.superseded",
    "artifact_publication",
    ArtifactPublicationPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.refusal_choice_requested",
    "run_lifecycle",
    RunRefusalChoiceRequestedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.refusal_choice_resolved",
    "run_lifecycle",
    RunRefusalChoiceResolvedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.usage_credits_choice_requested",
    "run_lifecycle",
    RunUsageCreditsChoiceRequestedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.usage_credits_choice_resolved",
    "run_lifecycle",
    RunUsageCreditsChoiceResolvedPayloadSchema,
  ),
  registerSessionEventVariant(
    "session.goal_updated",
    "session_lifecycle",
    SessionGoalUpdatedPayloadSchema,
  ),
  registerSessionEventVariant("session.renamed", "session_lifecycle", SessionRenamedPayloadSchema),
  registerSessionEventVariant(
    "pty.control_changed",
    "session_lifecycle",
    PtyControlChangedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.started",
    "workflow_lifecycle",
    WorkflowStartedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.resumed",
    "workflow_lifecycle",
    WorkflowResumedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.canceled",
    "workflow_lifecycle",
    WorkflowCanceledPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.run_deleted",
    "workflow_lifecycle",
    WorkflowRunDeletedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.results_posted",
    "workflow_lifecycle",
    WorkflowResultsPostedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.phase_suspended",
    "workflow_phase_lifecycle",
    WorkflowPhaseSuspendedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.step_started",
    "workflow_phase_lifecycle",
    WorkflowStepStartedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.step_finished",
    "workflow_phase_lifecycle",
    WorkflowStepFinishedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.step_failed",
    "workflow_phase_lifecycle",
    WorkflowStepFailedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.step_canceled",
    "workflow_phase_lifecycle",
    WorkflowStepCanceledPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.step_skipped",
    "workflow_phase_lifecycle",
    WorkflowStepSkippedPayloadSchema,
  ),
  registerSessionEventVariant(
    "workflow.gate_resolved",
    "workflow_gate_resolution",
    WorkflowGateResolvedPayloadSchema,
  ),
  registerSessionEventVariant(
    "backup.completed",
    "event_maintenance",
    BackupCompletedPayloadSchema,
  ),
  registerSessionEventVariant("backup.failed", "event_maintenance", BackupFailedPayloadSchema),
  registerSessionEventVariant("backup.restored", "event_maintenance", BackupRestoredPayloadSchema),
  registerSessionEventVariant(
    "recovery.attempted",
    "recovery_events",
    RecoveryAttemptedPayloadSchema,
  ),
  registerSessionEventVariant(
    "recovery.succeeded",
    "recovery_events",
    RecoverySucceededPayloadSchema,
  ),
  registerSessionEventVariant("recovery.failed", "recovery_events", RecoveryFailedPayloadSchema),
  registerSessionEventVariant(
    "recovery.damaged_events_skipped",
    "recovery_events",
    RecoveryDamagedEventsSkippedPayloadSchema,
  ),
  registerSessionEventVariant(
    "run.starting",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.starting,
  ),
  registerSessionEventVariant(
    "run.running",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.running,
  ),
  registerSessionEventVariant(
    "run.waiting_for_approval",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.waiting_for_approval,
  ),
  registerSessionEventVariant(
    "run.waiting_for_input",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.waiting_for_input,
  ),
  registerSessionEventVariant(
    "run.pausing",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.pausing,
  ),
  registerSessionEventVariant(
    "run.paused",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.paused,
  ),
  registerSessionEventVariant(
    "run.completed",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.completed,
  ),
  registerSessionEventVariant(
    "run.interrupted",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.interrupted,
  ),
  registerSessionEventVariant(
    "run.stopped",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.stopped,
  ),
  registerSessionEventVariant(
    "run.failed",
    "run_lifecycle",
    RUN_STATE_CHANGE_PAYLOAD_SCHEMAS.failed,
  ),
  registerSessionEventVariant(
    "intervention.requested",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.requested,
  ),
  registerSessionEventVariant(
    "intervention.accepted",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.accepted,
  ),
  registerSessionEventVariant(
    "intervention.applied",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.applied,
  ),
  registerSessionEventVariant(
    "intervention.rejected",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.rejected,
  ),
  registerSessionEventVariant(
    "intervention.degraded",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.degraded,
  ),
  registerSessionEventVariant(
    "intervention.expired",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.expired,
  ),
  registerSessionEventVariant(
    "intervention.failed",
    "interactive_request",
    INTERVENTION_EVENT_PAYLOAD_SCHEMAS.failed,
  ),
];

/**
 * The strict schema of one registered event type: the shared envelope members, its `type` and
 * `category` literals and its payload, with no unknown member.
 */
export type SessionEventVariantSchema = z.ZodObject<
  typeof EVENT_ENVELOPE_COMMON_SHAPE & {
    type: z.ZodLiteral<SessionEventType>;
    category: z.ZodLiteral<EventCategory>;
    payload: z.ZodType<object>;
  },
  z.core.$strict
>;

/**
 * The strict schema of each registered event type, built the first time it is asked for and kept.
 * A session sees a handful of the registered types, so the rest are never built.
 */
export class SessionEventVariantSchemas {
  readonly #registrationsByType: ReadonlyMap<string, SessionEventVariantRegistration> = new Map(
    SESSION_EVENT_VARIANT_REGISTRATIONS.map((registration) => [registration.type, registration]),
  );
  readonly #schemasByType = new Map<string, SessionEventVariantSchema>();

  /**
   * The schema of the event type `type` names, or `undefined` when no variant is registered for
   * it. A `Map` lookup, so an untrusted `type` such as `__proto__` cannot reach the prototype.
   */
  resolve(type: unknown): SessionEventVariantSchema | undefined {
    if (typeof type !== "string") {
      return undefined;
    }
    const built = this.#schemasByType.get(type);
    if (built !== undefined) {
      return built;
    }
    const registration = this.#registrationsByType.get(type);
    if (registration === undefined) {
      return undefined;
    }
    const schema = z
      .object({
        ...EVENT_ENVELOPE_COMMON_SHAPE,
        type: z.literal(registration.type),
        category: z.literal(registration.category),
        payload: registration.payload,
      })
      .strict();
    this.#schemasByType.set(type, schema);
    return schema;
  }
}

/** The one store of built variant schemas, which {@link SessionEventSchema} parses through. */
export const SESSION_EVENT_VARIANT_SCHEMAS: SessionEventVariantSchemas =
  new SessionEventVariantSchemas();

/** The event types with a payload variant registered in {@link SessionEventSchema}. */
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = Object.freeze(
  SESSION_EVENT_VARIANT_REGISTRATIONS.map((registration) => registration.type),
);

// A Zod schema type of its own, because only a schema's parse receives the caller's parse
// context: it hands the frame and that context to the chosen variant exactly as Zod's
// discriminated union hands them to its option, so issues, their abort state, the caller's error
// map and `reportInput` all reach the variant unchanged. The parse is installed by the
// initializer, so a `.superRefine()` clone keeps it.
const SessionEventDispatchSchema = z.core.$constructor<z.ZodType<SessionEvent>>(
  "SessionEventDispatchSchema",
  (inst, def) => {
    z.ZodType.init(inst, def);
    inst._zod.parse = (payload, context) => {
      const input = payload.value;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        payload.issues.push({ code: "invalid_type", expected: "object", input, inst });
        return payload;
      }
      const variantSchema = SESSION_EVENT_VARIANT_SCHEMAS.resolve(
        (input as Record<string, unknown>)["type"],
      );
      if (variantSchema === undefined) {
        payload.issues.push({
          code: "invalid_union",
          errors: [],
          note: "No matching discriminator",
          discriminator: "type",
          options: [...SESSION_EVENT_TYPES],
          input,
          path: ["type"],
          inst,
        });
        return payload;
      }
      return variantSchema._zod.run(payload, context);
    };
  },
);

/**
 * Strict parser for {@link SessionEvent}: an unknown type or a category that does not match its
 * type fails to parse. It parses as a Zod discriminated union over the registered variants does,
 * with the same output and issues, but builds a type's schema only when a value of that type is
 * first parsed.
 */
export const SessionEventSchema: z.ZodType<SessionEvent> = new SessionEventDispatchSchema({
  type: "custom",
});

// Cross-file ID types (`SessionId`, `UserId`, ...) are not re-exported here: each is imported from
// the module that declares it, so it has one import path.
