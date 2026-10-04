// How the provider drivers dispose of each normalized event kind: the daemon-side half of the
// event taxonomy.

import type { EventCategory } from "@ai-sidekicks/contracts/event-envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event-registry";

// The provider drivers normalize both provider wires into a fixed vocabulary of normalized kinds
// before the taxonomy maps each kind onto a `SessionEventType`. `EVENT_DISPOSITION_BY_KIND` is the
// machine-readable form of that mapping. Every kind has exactly one disposition: `adopt` names an
// event type, and every `correlate` and `discard` carries a stated reason, so no capability-bearing
// kind is dropped silently. A provider wire name that differs from its kind is mapped onto the
// kind in that provider's normalizer; the table names only what a kind becomes.
//
// The table covers the census kinds only. Wire-level channel discards and delta families belong
// to the normalizers' wire layer and are not keys here; a wire kind outside the census is caught
// by the normalizers' default-branch diagnostic, never by this table.
//
// An `eventType` that is not a census literal is a compile error, since it is typed
// `SessionEventType`.
//
// Registration is not emission license: a normalizer routes a registered kind to its diagnostic
// branch until the owning surface registers the payload variant in `SessionEventSchema`, so
// emission turns on variant by variant.

/**
 * One kind in the closed normalized vocabulary that the provider drivers map their wires into.
 * Blocks group related kinds; order is not load-bearing.
 */
export type NormalizedEventKind =
  // Inline transcript.
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
  | "refusal_choice_request"
  | "usage_credits_choice_request"
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
  // System, no transcript row.
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
  // Process and terminal.
  | "command_exit"
  | "terminal_interaction"
  // Wire echo.
  | "user_text"
  // Heavy, persisted.
  | "diff"
  | "command_output"
  | "thinking"
  | "proposed_plan";

/**
 * What a normalized kind becomes. `adopt` names a category and an `eventType` (a registered
 * {@link SessionEventType}). `correlate` and `discard` carry only a non-empty
 * `reason` and no taxonomy target: a correlate folds into an existing row via `correlation_id`,
 * and a discard is consumed transiently. `eventType` names the kind's primary target only;
 * outcome-dependent fan-out (`tool.error`, `approval.rejected` and `approval.canceled`,
 * `subagent.completed`) is the normalizer's business. The `never` members make a `reason` on an
 * adopt, or a target on a correlate or discard, a type error.
 *
 * Every property is `readonly` because {@link EVENT_DISPOSITION_BY_KIND} hands out shared
 * entries: `ReadonlyMap` blocks `.set()` but not property writes on an entry it returned, so a
 * consumer's `entry.category = ...` would otherwise corrupt the table process-wide.
 */
type EventKindDisposition =
  | {
      readonly disposition: "adopt";
      readonly category: EventCategory;
      readonly eventType: SessionEventType;
      readonly reason?: never;
    }
  | {
      readonly disposition: "correlate";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
    }
  | {
      readonly disposition: "discard";
      readonly reason: string;
      readonly category?: never;
      readonly eventType?: never;
    };

// Internal record behind the exported map; the `satisfies` check makes a missing, unregistered or
// duplicate key a compile error. Each entry names its kind's primary target; fan-out is the
// normalizer's concern.
const EVENT_DISPOSITION_RECORD = {
  // Inline transcript.
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
      "the answer is recorded as the person's own user.message turn by the call that " +
      "answered the question; its delivery to the provider is kept in the daemon's log only",
  },
  // The provider's retry-or-edit choice on a refused turn that names a fallback model. Its answer,
  // `run.refusal_choice_resolved`, is appended by the daemon when it answers and is no kind.
  refusal_choice_request: {
    disposition: "adopt",
    category: "run_lifecycle",
    eventType: "run.refusal_choice_requested",
  },
  // The provider's switch-or-credits choice when a turn needs usage credits. How it settles,
  // `run.usage_credits_choice_resolved`, is appended by the daemon and is no kind.
  usage_credits_choice_request: {
    disposition: "adopt",
    category: "run_lifecycle",
    eventType: "run.usage_credits_choice_requested",
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
  // Generic user-facing notice. A provider's own system-channel notice that repeats one is
  // discarded in its normalizer and is not a key here.
  notification: {
    disposition: "adopt",
    category: "session_lifecycle",
    eventType: "session.notice",
  },
  // Transient retry record; a provider's typed retry-error detail enriches this same kind, so it is
  // never dropped.
  api_retry: { disposition: "adopt", category: "usage_telemetry", eventType: "usage.api_retry" },
  // System, no transcript row.
  // Provider context-window compaction — distinct from the daemon
  // `event.compacted` retention pass.
  compact_boundary: {
    disposition: "adopt",
    category: "usage_telemetry",
    eventType: "usage.context_compacted",
  },
  // An account-plane quota snapshot, never context-window telemetry.
  rate_limits: {
    disposition: "adopt",
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
      "streaming-structural envelope boundary; the wrapped text_delta kind carries the " +
      "durable content — no separate transcript or persistence capability",
  },
  content_block_stop: {
    disposition: "discard",
    reason:
      "paired streaming envelope boundary; same streaming-structural reason as " +
      "content_block_start — the wrapped text_delta kind carries the durable content",
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
  // A detached child's terminal notice, injected into the parent's next turn.
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
  // Process and terminal.
  // A command's exit: exited during the wait, or yielded with a resumable session.
  command_exit: { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
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
      "a wire echo of a message the app sent: it confirms delivery and folds into that " +
      "message's user.message row via correlation_id, adding no persisted type; until " +
      "user.message has a payload variant, the echo routes to the normalizers' diagnostic " +
      "branch",
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
 * dropped; the section comment above says what it covers. A normalizer row that names a census
 * kind takes its target from this table ({@link resolveAdoptedEventTarget}). A `ReadonlyMap`, not
 * a plain object, so `.get()` is safe on untrusted input: a wire kind such as
 * `__proto__` or `constructor` resolves to `undefined`, never a truthy non-disposition value.
 */
const EVENT_DISPOSITION_BY_KIND: ReadonlyMap<NormalizedEventKind, EventKindDisposition> = new Map(
  // Sound by the `satisfies` check above: the record's keys are exactly the
  // `NormalizedEventKind` literals.
  Object.entries(EVENT_DISPOSITION_RECORD) as ReadonlyArray<
    [NormalizedEventKind, EventKindDisposition]
  >,
);

/** The session event a normalizer row emits: its category and its registered type. */
export interface AdoptedEventTarget {
  readonly category: EventCategory;
  readonly eventType: SessionEventType;
}

/**
 * The target the table adopts `kind` onto, for a normalizer row that names that kind. Throws for
 * a kind the table correlates or discards: a row that emits one contradicts the table.
 */
export function resolveAdoptedEventTarget(kind: NormalizedEventKind): AdoptedEventTarget {
  const disposition = EVENT_DISPOSITION_BY_KIND.get(kind);
  if (disposition?.disposition !== "adopt") {
    throw new Error(`normalized kind '${kind}' is not adopted by the disposition table`);
  }
  return { category: disposition.category, eventType: disposition.eventType };
}
