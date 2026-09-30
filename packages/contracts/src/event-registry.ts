// The closed roster of session event types, grouped by category, and how each normalized provider
// event kind is disposed of. The category record itself is in `event.ts`.

import type { EventCategory } from "./event-envelope.js";
import type { SessionEvent } from "./event-variant-types.js";

// Every wire `type` string. Each type belongs to exactly one category and
// `SESSION_EVENT_CATEGORY_BY_TYPE` (in `event.ts`) covers every type: its `satisfies
// Record<SessionEventType, EventCategory>` check makes a missing, unknown or duplicate key a
// compile error, and `__tests__/session-event.test.ts` checks the per-category partition. Type
// strings are immutable wire identifiers (MINOR bumps only add), so a registered literal is never
// renamed. Blocks follow `EventCategory` order, which is not load-bearing.
//
// A type's category is its registry entry, not its prefix: `session.clock_unsynced` and
// `session.clock_corrected` are `runtime_node_lifecycle` (they keep the `session.` prefix because
// a rename would break the wire), `daemon.*` and `relay.pin_refused` are `security_events`,
// `moderation.review_flagged` and `plan.*` are `approval_flow`, and `orchestration.rejected` is
// `orchestration_admission`.
/**
 * Every wire event type string the taxonomy registers, whether or not a payload variant exists
 * for it yet.
 */
export type SessionEventType =
  // run_lifecycle
  | "run.queued"
  | "run.starting"
  | "run.running"
  | "run.waiting_for_approval"
  | "run.waiting_for_input"
  | "run.pausing"
  | "run.paused"
  | "run.completed"
  | "run.interrupted"
  | "run.failed"
  | "run.rolled_back"
  | "run.provider_initialized"
  | "run.turn_started"
  | "run.worker_shutdown"
  | "run.step_limit_reached"
  | "run.recovery_resolved"
  // assistant_output
  | "assistant.message"
  | "assistant.thinking_update"
  // tool_activity
  | "tool.invoked"
  | "tool.result"
  | "tool.error"
  | "tool.replayed"
  | "tool.skipped_during_recovery"
  | "subagent.started"
  | "subagent.completed"
  | "command.ended"
  // interactive_request
  | "queue_item.created"
  | "queue_item.admitted"
  | "queue_item.superseded"
  | "queue_item.canceled"
  | "queue_item.not_delivered"
  | "intervention.requested"
  | "intervention.accepted"
  | "intervention.applied"
  | "intervention.rejected"
  | "intervention.degraded"
  | "intervention.expired"
  | "user.message"
  | "question.asked"
  // artifact_publication
  | "artifact.published"
  | "artifact.visibility_updated"
  | "artifact.superseded"
  | "diff.created"
  | "git.settled"
  // session_lifecycle
  | "session.created"
  | "session.activated"
  | "session.archived"
  | "session.reactivated"
  | "session.closed"
  | "session.purge_requested"
  | "session.purged"
  | "session.goal_updated"
  | "session.goal_cleared"
  | "session.provider_status"
  | "session.notice"
  | "session.renamed"
  | "session.pinned"
  | "session.unpinned"
  | "session.muted"
  | "session.unmuted"
  | "session.converted"
  | "session.side_question_answered"
  | "session.restore_finished"
  | "agent.provider_binding_changed"
  | "agent.provider_binding_change_failed"
  | "repo.attached"
  | "repo.detached"
  | "workspace.preparing"
  | "workspace.ready"
  | "workspace.stale"
  | "workspace.archived"
  | "worktree.created"
  | "worktree.ready"
  | "worktree.dirty"
  | "worktree.merged"
  | "worktree.retired"
  | "session.branch_changed"
  | "session.swept_to_repo_root"
  | "pty.control_changed"
  | "cloud.task_updated"
  // approval_flow
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.canceled"
  | "approval.remembered"
  | "approval.rule_revoked"
  | "approval.reviewer_denied"
  | "approval.denial_overridden"
  | "moderation.review_flagged"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.handed_off"
  // usage_telemetry
  | "usage.token_count"
  | "usage.cost_update"
  | "usage.context_window_update"
  | "usage.budget_warning"
  | "usage.rate_limit_update"
  | "usage.api_retry"
  | "usage.context_compacted"
  | "usage.model_rerouted"
  // runtime_node_lifecycle
  | "session.clock_unsynced"
  | "session.clock_corrected"
  // recovery_events
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  // security_events
  | "security.default.override"
  | "security.update.available"
  | "daemon.master_key_source"
  | "daemon.pii_split_ambiguous"
  | "relay.pin_refused"
  // event_maintenance
  | "event.compacted"
  | "backup.completed"
  | "backup.failed"
  | "backup.restored"
  // policy_events
  | "policy_bundle.loaded"
  | "policy_bundle.rejected"
  // orchestration_admission
  | "orchestration.rejected"
  // mcp_governance
  | "mcp.server_status_changed"
  | "mcp.server_config_changed"
  | "mcp.server_trust_changed"
  | "mcp.tool_override_changed"
  | "mcp.server_oauth_completed"
  // workflow_lifecycle
  | "workflow.created"
  | "workflow.started"
  | "workflow.gated"
  | "workflow.failed"
  | "workflow.completed"
  | "workflow.resumed"
  | "workflow.canceled"
  | "workflow.run_waiting"
  | "workflow.schedule_armed"
  | "workflow.schedule_fired"
  | "workflow.trigger_armed"
  | "workflow.trigger_fired"
  | "workflow.results_posted"
  // workflow_phase_lifecycle
  | "workflow.phase_admitted"
  | "workflow.phase_waiting_on_pool"
  | "workflow.phase_started"
  | "workflow.phase_progressed"
  | "workflow.phase_canceling"
  | "workflow.phase_failed"
  | "workflow.phase_retried"
  | "workflow.phase_suspended"
  | "workflow.phase_resumed"
  | "workflow.phase_completed"
  | "workflow.human_phase_claimed"
  | "workflow.human_phase_escalated"
  | "workflow.step_started"
  | "workflow.step_finished"
  | "workflow.step_failed"
  | "workflow.step_canceled"
  | "workflow.step_skipped"
  // workflow_parallel_coordination
  | "workflow.parallel_join_cancellation"
  // workflow_gate_resolution
  | "workflow.gate_resolved";

/**
 * The event types with a payload variant registered in `SessionEventSchema`: a subset of the
 * census (`SESSION_EVENT_CATEGORY_BY_TYPE`). The `SessionEvent["type"]` annotation refuses a
 * literal that has no variant. The list is hand-written, so registering a union arm means adding
 * its type here in the same change; `__tests__/event-source-epoch.test.ts` checks that it equals
 * the union's arms. Order follows the union arms.
 */
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.created",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "event.compacted",
  "assistant.message",
  "assistant.thinking_update",
  "tool.invoked",
  "tool.result",
  "tool.error",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
  "question.asked",
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
  "cloud.task_updated",
  "session.restore_finished",
  "session.goal_cleared",
  "session.notice",
  "session.side_question_answered",
  "git.settled",
  "relay.pin_refused",
  "command.ended",
  "usage.model_rerouted",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "approval.requested",
  "approval.approved",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "run.queued",
  "run.step_limit_reached",
  "run.recovery_resolved",
  "session.goal_updated",
  "session.renamed",
  "pty.control_changed",
  "workflow.started",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.results_posted",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
  "workflow.gate_resolved",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

// One exported const per `EventCategory`, named `<CATEGORY_IN_SCREAMING_SNAKE>_EVENT_TYPES`, so
// the `*_events` categories read `..._EVENTS_EVENT_TYPES`. Each array holds exactly the registry
// types of its category, and together the arrays partition the census; both are asserted in
// `__tests__/session-event.test.ts`. The explicit `readonly SessionEventType[]` annotations keep
// the exports `isolatedDeclarations`-clean.

/** The event types of the `run_lifecycle` category. */
export const RUN_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.pausing",
  "run.paused",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.rolled_back",
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
  "run.step_limit_reached",
  "run.recovery_resolved",
] as const;

/** The event types of the `assistant_output` category. */
export const ASSISTANT_OUTPUT_EVENT_TYPES: readonly SessionEventType[] = [
  "assistant.message",
  "assistant.thinking_update",
] as const;

/** The event types of the `tool_activity` category. */
export const TOOL_ACTIVITY_EVENT_TYPES: readonly SessionEventType[] = [
  "tool.invoked",
  "tool.result",
  "tool.error",
  "tool.replayed",
  "tool.skipped_during_recovery",
  "subagent.started",
  "subagent.completed",
  "command.ended",
] as const;

/** The event types of the `interactive_request` category. */
export const INTERACTIVE_REQUEST_EVENT_TYPES: readonly SessionEventType[] = [
  "queue_item.created",
  "queue_item.admitted",
  "queue_item.superseded",
  "queue_item.canceled",
  "queue_item.not_delivered",
  "intervention.requested",
  "intervention.accepted",
  "intervention.applied",
  "intervention.rejected",
  "intervention.degraded",
  "intervention.expired",
  "user.message",
  "question.asked",
] as const;

/** The event types of the `artifact_publication` category. */
export const ARTIFACT_PUBLICATION_EVENT_TYPES: readonly SessionEventType[] = [
  "artifact.published",
  "artifact.visibility_updated",
  "artifact.superseded",
  "diff.created",
  "git.settled",
] as const;

/**
 * The event types of the `session_lifecycle` category: session (including the side question, the
 * undo record, the pin and mute marks and a chat's conversion), agent, repo, workspace and
 * worktree (including the branch change and the sweep to the repository root), pty and cloud task.
 */
export const SESSION_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "session.activated",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.purge_requested",
  "session.purged",
  "session.goal_updated",
  "session.goal_cleared",
  "session.provider_status",
  "session.notice",
  "session.renamed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.side_question_answered",
  "session.restore_finished",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "pty.control_changed",
  "cloud.task_updated",
] as const;

/** The event types of the `approval_flow` category. */
export const APPROVAL_FLOW_EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
] as const;

/** The event types of the `usage_telemetry` category. */
export const USAGE_TELEMETRY_EVENT_TYPES: readonly SessionEventType[] = [
  "usage.token_count",
  "usage.cost_update",
  "usage.context_window_update",
  "usage.budget_warning",
  "usage.rate_limit_update",
  "usage.api_retry",
  "usage.context_compacted",
  "usage.model_rerouted",
] as const;

/**
 * The event types of the `runtime_node_lifecycle` category: the two `session.clock_*` events,
 * whose category is the registry's, not their namespace prefix's.
 */
export const RUNTIME_NODE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.clock_unsynced",
  "session.clock_corrected",
] as const;

/** The event types of the `recovery_events` category. */
export const RECOVERY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "recovery.attempted",
  "recovery.succeeded",
  "recovery.failed",
] as const;

/** The event types of the `security_events` category. */
export const SECURITY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "security.default.override",
  "security.update.available",
  "daemon.master_key_source",
  "daemon.pii_split_ambiguous",
  "relay.pin_refused",
] as const;

/** The event types of the `event_maintenance` category. */
export const EVENT_MAINTENANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "event.compacted",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

/** The event types of the `policy_events` category. */
export const POLICY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "policy_bundle.loaded",
  "policy_bundle.rejected",
] as const;

/** The event types of the `orchestration_admission` category. */
export const ORCHESTRATION_ADMISSION_EVENT_TYPES: readonly SessionEventType[] = [
  "orchestration.rejected",
] as const;

/**
 * The event types of the `mcp_governance` category. Four of the five bind to the daemon-scope
 * sentinel session; `mcp.server_status_changed` binds per event.
 */
export const MCP_GOVERNANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
] as const;

/** The event types of the `workflow_lifecycle` category. */
export const WORKFLOW_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.created",
  "workflow.started",
  "workflow.gated",
  "workflow.failed",
  "workflow.completed",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.run_waiting",
  "workflow.schedule_armed",
  "workflow.schedule_fired",
  "workflow.trigger_armed",
  "workflow.trigger_fired",
  "workflow.results_posted",
] as const;

/** The event types of the `workflow_phase_lifecycle` category. */
export const WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.phase_admitted",
  "workflow.phase_waiting_on_pool",
  "workflow.phase_started",
  "workflow.phase_progressed",
  "workflow.phase_canceling",
  "workflow.phase_failed",
  "workflow.phase_retried",
  "workflow.phase_suspended",
  "workflow.phase_resumed",
  "workflow.phase_completed",
  "workflow.human_phase_claimed",
  "workflow.human_phase_escalated",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
] as const;

/** The event types of the `workflow_parallel_coordination` category. */
export const WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.parallel_join_cancellation",
] as const;

/** The event types of the `workflow_gate_resolution` category. */
export const WORKFLOW_GATE_RESOLUTION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.gate_resolved",
] as const;

// The provider drivers normalize both provider wires into a fixed vocabulary of normalized kinds
// before the taxonomy maps each kind onto a `SessionEventType`. `EVENT_DISPOSITION_BY_KIND` is the
// machine-readable form of that mapping. Every kind has exactly one disposition: `adopt` and
// `rename` name an event type, and every `correlate` and `discard` carries a stated reason, so no
// capability-bearing kind is dropped silently.
//
// The registry covers the census kinds only. Wire-level channel discards and delta families
// belong to the normalizers' wire layer and are not keys here; a wire kind outside the census is
// caught by the normalizers' default-branch diagnostic, never by this registry.
//
// An entry may carry `typePending` in place of `eventType`: a literal minted ahead of its
// registration. No entry uses that arm now; it is kept for the next such case, and the
// normalizers route a pending kind to their diagnostic branch instead of building an envelope
// against a missing type. An `eventType` that is not a census literal is a compile error, since
// it is typed `SessionEventType`.
//
// Registration is not emission license: a normalizer routes a registered kind to its diagnostic
// branch until the owning surface registers the payload variant in `SessionEventSchema`, so
// emission turns on variant by variant.

// The closed set of normalized kinds. Blocks group related kinds; order is not load-bearing.
/** One kind in the normalized vocabulary that the provider drivers map their wires into. */
export type NormalizedEventKind =
  // Inline timeline.
  | "init"
  | "text_delta"
  | "tool_start"
  | "tool_complete"
  | "turn_start"
  | "turn_complete"
  | "approval_request"
  | "approval_resolved"
  | "user_input_request"
  | "user_input_resolved"
  | "session_status"
  | "token_usage"
  | "error"
  | "todo_update"
  // Task mirror.
  | "task_create"
  | "task_update"
  | "notification"
  // Transient retry.
  | "api_retry"
  // System, no timeline row.
  | "compact_boundary"
  | "rate_limits"
  | "model_rerouted"
  | "thread_renamed"
  | "content_block_start"
  | "content_block_stop"
  // Background and subagent.
  | "background_task_terminal"
  | "background_task_notification"
  | "subagent_notification"
  | "subagent_status"
  // Codex process and terminal.
  | "codex_exec_result"
  | "terminal_interaction"
  // Wire echo.
  | "user_text"
  // Heavy, persisted.
  | "diff"
  | "command_output"
  | "thinking"
  | "proposed_plan";

/** Every {@link NormalizedEventKind} as an iterable tuple, like the per-category arrays. */
export const NORMALIZED_EVENT_KINDS: readonly NormalizedEventKind[] = [
  "init",
  "text_delta",
  "tool_start",
  "tool_complete",
  "turn_start",
  "turn_complete",
  "approval_request",
  "approval_resolved",
  "user_input_request",
  "user_input_resolved",
  "session_status",
  "token_usage",
  "error",
  "todo_update",
  "task_create",
  "task_update",
  "notification",
  "api_retry",
  "compact_boundary",
  "rate_limits",
  "model_rerouted",
  "thread_renamed",
  "content_block_start",
  "content_block_stop",
  "background_task_terminal",
  "background_task_notification",
  "subagent_notification",
  "subagent_status",
  "codex_exec_result",
  "terminal_interaction",
  "user_text",
  "diff",
  "command_output",
  "thinking",
  "proposed_plan",
] as const;

/**
 * What a normalized kind becomes. `adopt` and `rename` name a category and exactly one of
 * `eventType` (a registered {@link SessionEventType}) or `typePending` (a literal minted ahead of
 * its registration; no entry uses this arm now). `correlate` and `discard` carry only a non-empty
 * `reason` and no taxonomy target: a correlate folds into an existing row via `correlation_id`,
 * and a discard is consumed transiently. `eventType` names the kind's primary target only;
 * outcome-dependent fan-out (`tool.error`, `approval.rejected` and `approval.canceled`,
 * `subagent.completed`) is the normalizer's business. The `never` members make an entry with both
 * targets, or with a `reason` on an adopt or rename, a type error.
 *
 * Every property is `readonly` because {@link EVENT_DISPOSITION_BY_KIND} hands out shared
 * entries: `ReadonlyMap` blocks `.set()` but not property writes on an entry it returned, so a
 * consumer's `entry.category = ...` would otherwise corrupt the registry process-wide.
 */
export type EventKindDisposition =
  | {
      readonly disposition: "adopt" | "rename";
      readonly category: EventCategory;
      readonly eventType: SessionEventType;
      readonly typePending?: never;
      readonly reason?: never;
    }
  | {
      readonly disposition: "adopt" | "rename";
      readonly category: EventCategory;
      readonly typePending: "B18";
      readonly eventType?: never;
      readonly reason?: never;
    }
  | {
      readonly disposition: "correlate";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
      readonly typePending?: never;
    }
  | {
      readonly disposition: "discard";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
      readonly typePending?: never;
    };

// Internal record behind the exported map, like `SESSION_EVENT_CATEGORY_RECORD`. The `satisfies
// Record<NormalizedEventKind, EventKindDisposition>` check makes a missing, unregistered or
// duplicate key a compile error, and the `EventKindDisposition` arms reject an entry that carries
// both `eventType` and `typePending`, a `reason` beside a taxonomy target, or a taxonomy target
// on a correlate or discard. Each entry names its kind's primary target; fan-out is the
// normalizer's concern.
const EVENT_DISPOSITION_RECORD = {
  // Inline timeline.
  // Run-start marker: the provider's own init report. The daemon's `run.*` state transitions stay
  // daemon-emitted, never mapped from a provider init.
  init: {
    disposition: "adopt",
    category: "run_lifecycle",
    eventType: "run.provider_initialized",
  },
  text_delta: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.message",
  },
  tool_start: { disposition: "adopt", category: "tool_activity", eventType: "tool.invoked" },
  // Tool-lifecycle completion; a failure outcome fans to `tool.error`.
  tool_complete: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Turn boundary.
  turn_start: { disposition: "adopt", category: "run_lifecycle", eventType: "run.turn_started" },
  // Turn complete; `completionKind` separates a turn from a task.
  turn_complete: { disposition: "adopt", category: "run_lifecycle", eventType: "run.completed" },
  // A provider's permission ask that reaches a person, recorded once as the
  // approval it opens. An ask the daemon answers itself, by a policy allow or a
  // remembered rule, appends nothing: the tool row is the record.
  approval_request: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.requested",
  },
  // Approval resolution; fans by outcome to `approval.rejected` /
  // `approval.canceled`.
  approval_resolved: {
    disposition: "adopt",
    category: "approval_flow",
    eventType: "approval.approved",
  },
  // A structured question to the person: the question record the card renders.
  user_input_request: {
    disposition: "adopt",
    category: "interactive_request",
    eventType: "question.asked",
  },
  user_input_resolved: {
    disposition: "discard",
    reason:
      "the answer is recorded as the person's own user.message turn by the call that answered the question; its delivery to the provider is kept in the daemon's log only",
  },
  // Coarse provider status; it never drives a `session.*` state transition, so none is fabricated.
  session_status: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.provider_status",
  },
  token_usage: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.token_count",
  },
  // Run-failure envelope.
  error: { disposition: "adopt", category: "run_lifecycle", eventType: "run.failed" },
  // Todo-snapshot projection (TodoWrite-family result row).
  todo_update: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Task mirror: per-task create and update fold into the per-thread mirror and `todo_update`
  // snapshots.
  task_create: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  task_update: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Generic user-facing notice fed by Codex; Claude's system-channel `notification` subtype is
  // discarded in the wire layer and is not a registry key.
  notification: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.notice",
  },
  // Transient retry record; Claude's `system.api_retry` typed-error enum enriches this same kind,
  // so it is never dropped.
  api_retry: { disposition: "adopt", category: "usage_telemetry", eventType: "usage.api_retry" },
  // System, no timeline row.
  // Provider context-window compaction — distinct from the daemon
  // `event.compacted` retention pass.
  compact_boundary: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.context_compacted",
  },
  // The Claude wire string `rate_limit_event` RENAMES onto `rate_limits`:
  // an account-plane quota snapshot, never context-window telemetry.
  rate_limits: {
    disposition: "rename",
    category: "usage_telemetry",
    eventType: "usage.rate_limit_update",
  },
  // Mid-run model-reroute telemetry.
  model_rerouted: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.model_rerouted",
  },
  // Session/thread rename.
  thread_renamed: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.renamed",
  },
  content_block_start: {
    disposition: "discard",
    reason:
      "streaming-structural envelope boundary; the wrapped text_delta kind carries the durable content — no separate timeline or persistence capability",
  },
  content_block_stop: {
    disposition: "discard",
    reason:
      "paired streaming envelope boundary; same streaming-structural reason as content_block_start — the wrapped text_delta kind carries the durable content",
  },
  // Background and subagent.
  // Richer sibling completion; never replaces the tool-lifecycle
  // completion row.
  background_task_terminal: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.completed",
  },
  // Non-lifecycle task notice; may carry a durable output-file path.
  background_task_notification: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "tool.result",
  },
  // Codex detached-child terminal injected into the parent's next turn.
  subagent_notification: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.completed",
  },
  // Subagent-lifecycle row / internal child-thread status; fans to
  // `subagent.completed`.
  subagent_status: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "subagent.started",
  },
  // Codex process and terminal.
  // Raw exec-output signal — exited-during-wait vs
  // yielded-with-resumable-session.
  codex_exec_result: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  // Stdin writes to a backgrounded PTY; non-empty stdin redacted from
  // durable metadata.
  terminal_interaction: {
    disposition: "adopt",
    category: "tool_activity",
    eventType: "tool.invoked",
  },
  // Wire echo.
  user_text: {
    disposition: "correlate",
    reason:
      "correlation-only wire echo — folds into the originating app-sent user-message row via correlation_id (delivery confirmation of the pending send; no new persisted type); correlate target user.message (B18-minted 2026-07-22, registered in this census so the target literal resolves; the echo keeps routing to normalizer default-branch diagnostic until user.message payload variant joins the union)",
  },
  // Heavy, persisted: the payload goes to SQLite and light metadata to the client.
  diff: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  command_output: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  thinking: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.thinking_update",
  },
  // Plan proposal.
  proposed_plan: {
    disposition: "adopt",
    category: "assistant_output",
    eventType: "assistant.message",
  },
} satisfies Record<NormalizedEventKind, EventKindDisposition>;

/**
 * The disposition of each normalized kind: what the taxonomy makes of it, or why it is folded or
 * dropped. The normalizers consult it; the section comment above says what it covers. A
 * `ReadonlyMap`, not a plain object, for the same `.get()` safety as
 * {@link SESSION_EVENT_CATEGORY_BY_TYPE}: an untrusted wire kind such as `__proto__` or
 * `constructor` resolves to `undefined`, never a truthy non-disposition value.
 */
export const EVENT_DISPOSITION_BY_KIND: ReadonlyMap<NormalizedEventKind, EventKindDisposition> =
  new Map(
    // Sound by the `satisfies` check above: the record's keys are exactly the
    // `NormalizedEventKind` literals.
    Object.entries(EVENT_DISPOSITION_RECORD) as ReadonlyArray<
      [NormalizedEventKind, EventKindDisposition]
    >,
  );
