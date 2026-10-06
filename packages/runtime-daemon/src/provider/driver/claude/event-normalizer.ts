// Claude half of the driver normalize boundary, mirroring `../codex/event-normalizer.ts`: a pure,
// total mapping from a pinned stream-json or control-channel frame kind to its event category.
//
// Rows come from the version-pinned Claude wire census (recorded at `2.1.251`; vectors in
// `__fixtures__/`, so a re-pin fails a test). A row that names a normalized kind takes its category
// and event type from `EVENT_DISPOSITION_BY_KIND`; a row with no kind states its own.
//
// Left out on purpose, so the diagnostic default branch reports them instead of a guessed row:
// the `assistant` / `user` message frames (no authless probe records their shape), the subagent
// signals (see {@link normalizeClaudeSubagentLifecycle}), `command_lifecycle`,
// `queued_notification` (daemon-to-CLI, so anomalous inbound), `model_refusal_*`,
// `prompt_suggestion`, and the `set_effort`, `rewind` and `compact` control subtypes.

import { SESSION_EVENT_TYPES } from "@ai-sidekicks/contracts/event/session";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { DriverDiagnosticRecord, DriverDiagnosticsEmitter } from "../diagnostics.js";
import type { ChildThreadAnnouncement, ThreadFrameFamilyClass } from "../../thread-frame-router.js";
import { resolveAdoptedEventTarget, type NormalizedEventKind } from "../../event-disposition.js";

/**
 * Which channel carried the frame: stdout stream-json, or one half of the control channel. Not a
 * direction axis: control traffic runs both ways under one frame type.
 */
type ClaudeWireChannel = "stream" | "control-request" | "control-response";

/**
 * The pinned inbound frame-kind census with a settled disposition: the frame `type` joined to its
 * subtype by `/`. Closed, so the record's `satisfies` check proves every kind has a row.
 */
export type ClaudeWireFrameKind =
  // Stream channel, `type: "system"`.
  | "system/init"
  | "system/api_retry"
  | "system/api_error"
  | "system/rate_limit_event"
  | "system/compact_boundary"
  | "system/worker_shutting_down"
  | "system/hook_started"
  | "system/hook_progress"
  | "system/hook_response"
  | "system/notification"
  | "system/files_persisted"
  | "system/tool_use_summary"
  | "system/memory_recall"
  | "system/local_command_output"
  | "system/task_progress"
  // Stream channel, `type: "result"`.
  | "result/success"
  | "result/error_max_turns"
  | "result/error_max_budget_usd"
  | "result/error_during_execution"
  | "result/error_max_structured_output_retries"
  // Control channel, CLI -> daemon.
  | "control_request/can_use_tool"
  | "control_request/elicitation"
  | "control_request/request_user_dialog"
  | "control_request/hook_callback"
  | "control_request/mcp_message"
  | "control_request/mcp_set_servers"
  | "control_request/interrupt"
  | "control_request/set_permission_mode"
  | "control_request/set_model"
  | "control_request/get_usage"
  | "control_request/get_context_usage"
  | "control_request/get_session_cost"
  | "control_request/list_models"
  | "control_request/get_binary_version"
  | "control_request/apply_flag_settings"
  | "control_request/rewind_files"
  // Control channel, CLI -> daemon, answering a daemon request.
  | "control_response/success"
  | "control_response/error";

/**
 * Whether a row's target type can be built into an envelope: it needs a payload variant in
 * `SessionEventSchema`. `payload-variant-pending` rows feed the diagnostic, never an envelope.
 */
type ClaudeEmissionReadiness = "envelope-constructible" | "payload-variant-pending";

// Derived from `SESSION_EVENT_TYPES`, which is bound to the live schema union at compile time.
const REGISTERED_PAYLOAD_VARIANT_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set(
  SESSION_EVENT_TYPES,
);

/** Whether `eventType` may be built into a `SessionEvent` envelope. Pure and total. */
function resolveClaudeEmissionReadiness(eventType: SessionEventType): ClaudeEmissionReadiness {
  return REGISTERED_PAYLOAD_VARIANT_EVENT_TYPES.has(eventType)
    ? "envelope-constructible"
    : "payload-variant-pending";
}

/**
 * A frame that normalizes into one event category. `normalizedKind` is `null` for a member the
 * census does not name (`worker_shutting_down`). Entries are frozen shared singletons.
 */
export interface ClaudeNormalizedCategoryEmission {
  readonly disposition: "normalized";
  readonly frameKind: ClaudeWireFrameKind;
  readonly channel: ClaudeWireChannel;
  readonly category: EventCategory;
  readonly eventType: SessionEventType;
  readonly normalizedKind: NormalizedEventKind | null;
  readonly emissionReadiness: ClaudeEmissionReadiness;
}

/**
 * A known frame that carries no transcript capability, so it normalizes to no category. The
 * non-empty `reason` is mandatory, and the `?: never` keys forbid a taxonomy target.
 */
interface ClaudeNotEventedFrameDisposition {
  readonly disposition: "not-evented";
  readonly frameKind: ClaudeWireFrameKind;
  readonly channel: ClaudeWireChannel;
  readonly reason: string;
  readonly category?: never;
  readonly eventType?: never;
  readonly normalizedKind?: never;
  readonly emissionReadiness?: never;
}

/** The total result of normalizing one pinned Claude inbound frame kind. */
export type ClaudeFrameNormalization =
  | ClaudeNormalizedCategoryEmission
  | ClaudeNotEventedFrameDisposition;

// A table row before its derived members are put on it, so no row states a second copy: a row
// naming a kind takes `category` and `eventType` from the disposition table, and every row's
// `emissionReadiness` follows from its event type.
type ClaudeFrameNormalizationTableRow =
  | (Omit<ClaudeNormalizedCategoryEmission, "emissionReadiness" | "category" | "eventType"> & {
      readonly normalizedKind: NormalizedEventKind;
      readonly category?: never;
      readonly eventType?: never;
    })
  | (Omit<ClaudeNormalizedCategoryEmission, "emissionReadiness"> & {
      readonly normalizedKind: null;
    })
  | ClaudeNotEventedFrameDisposition;

function composeClaudeFrameNormalization(
  row: ClaudeFrameNormalizationTableRow,
): ClaudeFrameNormalization {
  if (row.disposition === "not-evented") {
    return row;
  }
  const target =
    row.normalizedKind === null
      ? { category: row.category, eventType: row.eventType }
      : resolveAdoptedEventTarget(row.normalizedKind);
  return {
    ...row,
    ...target,
    emissionReadiness: resolveClaudeEmissionReadiness(target.eventType),
  };
}

/**
 * Thrown for a frame kind outside the census. `frameKind` is untrusted provider output, kept
 * verbatim as data. It has no dotted `code`: the refusal rides no error envelope.
 */
export class UnknownClaudeWireFrameError extends Error {
  readonly frameKind: string;

  constructor(frameKind: string) {
    super(
      `Unmapped Claude inbound frame kind: ${JSON.stringify(frameKind)}. ` +
        "The pinned census does not cover it; the daemon diagnostic default branch " +
        "replaces this refusal on the routed normalize path.",
    );
    this.name = "UnknownClaudeWireFrameError";
    this.frameKind = frameKind;
  }
}

// A `satisfies Record<ClaudeWireFrameKind, ...>` literal, not a `switch`: a missing or excess key
// fails the build. The derived members are put on each row when the lookup map is built.
const CLAUDE_FRAME_NORMALIZATION_RECORD = {
  // A forward marker only: `run.*` transitions stay daemon-emitted, not derived from init.
  "system/init": {
    disposition: "normalized",
    frameKind: "system/init",
    channel: "stream",
    normalizedKind: "init",
  },
  // The typed-error enum members are carried verbatim by the payload layer: a string census
  // cannot prove the set closed.
  "system/api_retry": {
    disposition: "normalized",
    frameKind: "system/api_retry",
    channel: "stream",
    normalizedKind: "api_retry",
  },
  // The census maps `system/api_error` onto `system/api_retry`.
  "system/api_error": {
    disposition: "normalized",
    frameKind: "system/api_error",
    channel: "stream",
    normalizedKind: "api_retry",
  },
  // The rename happens here: the wire's `rate_limit_event` becomes the `rate_limits` kind, an
  // account quota snapshot. It is the preferred carrier because it is pushed, with no round trip
  // on the experimental `get_usage`.
  "system/rate_limit_event": {
    disposition: "normalized",
    frameKind: "system/rate_limit_event",
    channel: "stream",
    normalizedKind: "rate_limits",
  },
  // Provider context-window compaction, distinct from the daemon's `event.compacted` pass.
  "system/compact_boundary": {
    disposition: "normalized",
    frameKind: "system/compact_boundary",
    channel: "stream",
    normalizedKind: "compact_boundary",
  },
  // Wire-layer, not a registry key, so `normalizedKind` is `null`. Assumed on the system channel;
  // on another it misses this row and reaches the loud diagnostic seam.
  "system/worker_shutting_down": {
    disposition: "normalized",
    frameKind: "system/worker_shutting_down",
    channel: "stream",
    category: "run_lifecycle",
    eventType: "run.worker_shutdown",
    normalizedKind: null,
  },

  // Discarded system subtypes.
  "system/hook_started": {
    disposition: "not-evented",
    frameKind: "system/hook_started",
    channel: "stream",
    reason:
      "hook-lifecycle progress; hook execution is daemon-internal orchestration, not a " +
      "capability the transcript or audit log records",
  },
  "system/hook_progress": {
    disposition: "not-evented",
    frameKind: "system/hook_progress",
    channel: "stream",
    reason: "intra-hook progress; same daemon-internal-orchestration reason",
  },
  "system/hook_response": {
    disposition: "not-evented",
    frameKind: "system/hook_response",
    channel: "stream",
    reason: "hook result consumed by the hook dispatcher, not a transcript capability",
  },
  "system/notification": {
    disposition: "not-evented",
    frameKind: "system/notification",
    channel: "stream",
    reason:
      "distinct from the `notification` kind, which Codex feeds; the user-facing-notice " +
      "capability is already carried there — this Claude system subtype is redundant " +
      "transport noise",
  },
  "system/files_persisted": {
    disposition: "not-evented",
    frameKind: "system/files_persisted",
    channel: "stream",
    reason:
      "file-write summary; the adopted `diff` / `command_output` kinds plus " +
      "`artifact_publication` already carry the file-change capability",
  },
  "system/tool_use_summary": {
    disposition: "not-evented",
    frameKind: "system/tool_use_summary",
    channel: "stream",
    reason: "aggregate over the adopted `tool_start` / `tool_complete` kinds; no new capability",
  },
  "system/memory_recall": {
    disposition: "not-evented",
    frameKind: "system/memory_recall",
    channel: "stream",
    reason:
      "provider-internal memory-retrieval signal; no capability the transcript or audit log " +
      "records",
  },
  "system/local_command_output": {
    disposition: "not-evented",
    frameKind: "system/local_command_output",
    channel: "stream",
    reason:
      "superseded by the adopted `command_output` kind; the local variant carries no " +
      "additional capability",
  },
  "system/task_progress": {
    disposition: "not-evented",
    frameKind: "system/task_progress",
    channel: "stream",
    reason:
      "intra-task progress; the adopted `task_create` / `task_update` kinds and " +
      "`todo_update` snapshots carry the durable task state",
  },

  // A `result` frame does not end the read loop (trailing events can follow), so the loop reads
  // to EOF and no row here is terminal for the stream.
  "result/success": {
    disposition: "normalized",
    frameKind: "result/success",
    channel: "stream",
    normalizedKind: "turn_complete",
  },
  "result/error_max_turns": {
    disposition: "normalized",
    frameKind: "result/error_max_turns",
    channel: "stream",
    normalizedKind: "error",
  },
  "result/error_max_budget_usd": {
    disposition: "normalized",
    frameKind: "result/error_max_budget_usd",
    channel: "stream",
    normalizedKind: "error",
  },
  "result/error_during_execution": {
    disposition: "normalized",
    frameKind: "result/error_during_execution",
    channel: "stream",
    normalizedKind: "error",
  },
  "result/error_max_structured_output_retries": {
    disposition: "normalized",
    frameKind: "result/error_max_structured_output_retries",
    channel: "stream",
    normalizedKind: "error",
  },

  // Control channel, CLI -> daemon. Only `can_use_tool` and `elicitation` are asks aimed at the
  // person; the rest are answered by the driver's control dispatcher or never sent.
  // A permission ask, recorded once as the approval it opens. Claude Code's question tool also
  // arrives here; `normalizeClaudeCanUseToolRequest` splits it off by tool name.
  "control_request/can_use_tool": {
    disposition: "normalized",
    frameKind: "control_request/can_use_tool",
    channel: "control-request",
    normalizedKind: "approval_request",
  },
  // An MCP elicitation, recorded as the same question record the question tool yields.
  "control_request/elicitation": {
    disposition: "normalized",
    frameKind: "control_request/elicitation",
    channel: "control-request",
    normalizedKind: "user_input_request",
  },
  "control_request/request_user_dialog": {
    disposition: "not-evented",
    frameKind: "control_request/request_user_dialog",
    channel: "control-request",
    reason:
      "a host-rendered dialog, sent only for a kind the host declared at `initialize`; the " +
      "CLI fails closed on any other. The daemon's two kinds are `refusal_fallback_prompt` " +
      "and `fable_overage_consent_prompt`, recorded as `run.refusal_choice_requested` and " +
      "`run.usage_credits_choice_requested`, and neither arrives until the driver declares " +
      "them. `auto_mode_server_fallback` stays undeclared, its words reaching the working " +
      "line as a provider warning, and `auto_mode_outside_reads` never reaches a headless host",
  },
  "control_request/hook_callback": {
    disposition: "not-evented",
    frameKind: "control_request/hook_callback",
    channel: "control-request",
    reason:
      "hook family, disposed `discard`: hook-lifecycle, daemon-internal orchestration, not a " +
      "capability the transcript or audit log records",
  },
  "control_request/mcp_message": {
    disposition: "not-evented",
    frameKind: "control_request/mcp_message",
    channel: "control-request",
    reason:
      "MCP transport passthrough between the CLI and a configured server; the daemon's own " +
      "MCP governance surface events its decisions (`mcp.*`), so relaying the transport " +
      "frame would double-record events the daemon already audits",
  },
  // Absent from the census, but the CLI answers it; in the union because it dispatches, and
  // not-evented because the daemon sends it.
  "control_request/mcp_set_servers": {
    disposition: "not-evented",
    frameKind: "control_request/mcp_set_servers",
    channel: "control-request",
    reason:
      "daemon-originated live server-set reconcile; the driver's control dispatcher owns the " +
      "round trip and the resulting server-set change is already evented by the daemon's MCP " +
      "governance surface",
  },
  "control_request/interrupt": {
    disposition: "not-evented",
    frameKind: "control_request/interrupt",
    channel: "control-request",
    reason:
      "daemon-originated control request; the intervention that caused it is already evented " +
      "by the daemon's intervention surface, and the driver's control dispatcher owns the " +
      "request/response round trip",
  },
  "control_request/set_permission_mode": {
    disposition: "not-evented",
    frameKind: "control_request/set_permission_mode",
    channel: "control-request",
    reason:
      "daemon-originated control request; execution posture is daemon-owned and evented when " +
      "the daemon applies it, so relaying the request would double-record a mutation the " +
      "daemon authored",
  },
  "control_request/set_model": {
    disposition: "not-evented",
    frameKind: "control_request/set_model",
    channel: "control-request",
    reason:
      "daemon-originated control request; the agent-configuration change it carries is " +
      "evented by the daemon that applied it, not by the wire frame that requested it",
  },
  "control_request/get_usage": {
    disposition: "not-evented",
    frameKind: "control_request/get_usage",
    channel: "control-request",
    reason:
      "daemon-originated read of the experimental usage surface; its ANSWER is what carries " +
      "telemetry, and the push carrier `system/rate_limit_event` is the preferred source " +
      "where both are available",
  },
  "control_request/get_context_usage": {
    disposition: "not-evented",
    frameKind: "control_request/get_context_usage",
    channel: "control-request",
    reason:
      "daemon-originated read; the request carries no observation, and the context-window " +
      "telemetry its answer yields reaches the transcript through the driver's own usage " +
      "emission",
  },
  "control_request/get_session_cost": {
    disposition: "not-evented",
    frameKind: "control_request/get_session_cost",
    channel: "control-request",
    reason:
      "daemon-originated read; cost reaches the transcript through the driver's " +
      "`usage.cost_update` emission, never through the request that polled for it",
  },
  "control_request/list_models": {
    disposition: "not-evented",
    frameKind: "control_request/list_models",
    channel: "control-request",
    reason:
      "daemon-originated capability discovery; a discovery read is not a transcript capability",
  },
  "control_request/get_binary_version": {
    disposition: "not-evented",
    frameKind: "control_request/get_binary_version",
    channel: "control-request",
    reason:
      "daemon-originated version read; the reported CLI version is persisted on the binding " +
      "record at the driver write seam, not evented",
  },
  "control_request/apply_flag_settings": {
    disposition: "not-evented",
    frameKind: "control_request/apply_flag_settings",
    channel: "control-request",
    reason:
      "daemon-originated settings push; the daemon authored the settings and its typed " +
      "refusal is classified by the control dispatcher, so neither half is a provider " +
      "observation",
  },
  "control_request/rewind_files": {
    disposition: "not-evented",
    frameKind: "control_request/rewind_files",
    channel: "control-request",
    reason:
      "daemon-originated file-side rewind; the rollback that drove it is evented by the " +
      "daemon's intervention surface, and a cloud-hosted session refuses this subtype " +
      "outright, which is a dispatcher classification rather than a transcript row",
  },

  // Control channel, CLI -> daemon, answering a daemon-originated request. The census records the
  // error arm as `{ type: "control_response", response: { subtype: "error", request_id, error } }`.
  "control_response/success": {
    disposition: "not-evented",
    frameKind: "control_response/success",
    channel: "control-response",
    reason:
      "answer to a daemon-originated control request, correlated by `request_id`; the " +
      "control dispatcher resolves the pending call and whatever the answer authorizes is " +
      "evented by the surface that acted on it",
  },
  "control_response/error": {
    disposition: "not-evented",
    frameKind: "control_response/error",
    channel: "control-response",
    reason:
      "typed control-channel refusal, correlated by `request_id`; every control request is " +
      "feature-detected at call time by classifying this arm, which makes it a capability " +
      "signal for the dispatcher rather than a transcript row",
  },
} as const satisfies Record<ClaudeWireFrameKind, ClaudeFrameNormalizationTableRow>;

/** The census as an iterable tuple, derived from the record's own keys so it cannot drift. */
export const CLAUDE_WIRE_FRAME_KINDS: readonly ClaudeWireFrameKind[] = Object.freeze(
  Object.keys(CLAUDE_FRAME_NORMALIZATION_RECORD) as ClaudeWireFrameKind[],
);

/**
 * The frame-kind to normalization map. A `Map`, not the record, because the key is composed from
 * untrusted strings and `lookup["__proto__"]` on an object would return a truthy non-value.
 */
const CLAUDE_FRAME_NORMALIZATION_BY_KIND: ReadonlyMap<
  ClaudeWireFrameKind,
  ClaudeFrameNormalization
> = new Map(
  // Sound by the `satisfies` check above.
  (
    Object.entries(CLAUDE_FRAME_NORMALIZATION_RECORD) as ReadonlyArray<
      [ClaudeWireFrameKind, ClaudeFrameNormalizationTableRow]
    >
  ).map(([frameKind, row]) => [frameKind, Object.freeze(composeClaudeFrameNormalization(row))]),
);

/**
 * Composes the census key from a frame's `type` and subtype; a `null` subtype yields the bare
 * `type`, which is no census kind and so reaches the diagnostic seam. Inputs are untrusted.
 */
export function composeClaudeWireFrameKind(frameType: string, subtype: string | null): string {
  return subtype === null ? frameType : `${frameType}/${subtype}`;
}

/**
 * Normalizes one frame kind that parsed off the wire (unparseable bytes fail closed at the read
 * loop). Pure and total over the census, returning frozen singletons; throws
 * {@link UnknownClaudeWireFrameError} for a kind outside it.
 */
export function normalizeClaudeWireFrame(frameKind: string): ClaudeFrameNormalization {
  const normalization = CLAUDE_FRAME_NORMALIZATION_BY_KIND.get(frameKind as ClaudeWireFrameKind);
  if (normalization === undefined) {
    throw new UnknownClaudeWireFrameError(frameKind);
  }
  return normalization;
}

// Claude Code's question tool.
const CLAUDE_QUESTION_TOOL_NAME = "AskUserQuestion";

const CLAUDE_QUESTION_TOOL_NORMALIZATION: ClaudeFrameNormalization = Object.freeze(
  composeClaudeFrameNormalization({
    disposition: "normalized",
    frameKind: "control_request/can_use_tool",
    channel: "control-request",
    normalizedKind: "user_input_request",
  }),
);

/**
 * Normalizes a `can_use_tool` request by tool name: Claude Code's question tool becomes
 * `question.asked`, every other tool gets the table's permission-ask row. `toolName` is untrusted.
 */
export function normalizeClaudeCanUseToolRequest(toolName: string): ClaudeFrameNormalization {
  return toolName === CLAUDE_QUESTION_TOOL_NAME
    ? CLAUDE_QUESTION_TOOL_NORMALIZATION
    : normalizeClaudeWireFrame("control_request/can_use_tool");
}

/** The census-mapped emission answer, or the frame's routed diagnostic. */
export type ClaudeFrameEmissionRoute =
  | { readonly route: "emit"; readonly normalization: ClaudeNormalizedCategoryEmission }
  | { readonly route: "not-evented"; readonly normalization: ClaudeNotEventedFrameDisposition }
  | { readonly route: "diagnostic"; readonly record: DriverDiagnosticRecord };

/**
 * The driver core's entry point onto the table. Never throws: an unknown kind or a target without
 * a payload variant routes to a diagnostic record, never to an envelope or a silent drop.
 */
export function resolveClaudeFrameEmissionRoute(
  frameKind: string,
  diagnostics: DriverDiagnosticsEmitter,
): ClaudeFrameEmissionRoute {
  const normalization = CLAUDE_FRAME_NORMALIZATION_BY_KIND.get(frameKind as ClaudeWireFrameKind);
  if (normalization === undefined) {
    const record: DriverDiagnosticRecord = {
      provider: "claude",
      kind: "unmapped_wire_kind",
      rawWireType: frameKind,
      dispositionReason:
        "wire kind outside the pinned Claude inbound census; routed to the daemon diagnostic " +
        "default branch, never silently dropped and never forced into an envelope",
      details: {},
    };
    diagnostics.emit(record);
    return { route: "diagnostic", record };
  }
  if (normalization.disposition === "not-evented") {
    return { route: "not-evented", normalization };
  }
  if (normalization.emissionReadiness === "payload-variant-pending") {
    const record: DriverDiagnosticRecord = {
      provider: "claude",
      kind: "payload_variant_pending",
      rawWireType: frameKind,
      dispositionReason:
        "normalized kind whose target SessionEventType has no registered SessionEventSchema " +
        "payload variant; envelope construction is forbidden without one, so the frame " +
        "routes to the diagnostic branch",
      details: { eventType: normalization.eventType },
    };
    diagnostics.emit(record);
    return { route: "diagnostic", record };
  }
  return { route: "emit", normalization };
}

/**
 * Wire name of a Claude subagent start, which arrives in the parent's stream with
 * `parent_tool_use_id`. Claimed by name, outside the census, which holds only recorded kinds.
 */
export const CLAUDE_SUBAGENT_START_SIGNAL = "SubagentStart" as const;

/** Wire name of a Claude subagent stop; see {@link CLAUDE_SUBAGENT_START_SIGNAL}. */
const CLAUDE_SUBAGENT_STOP_SIGNAL = "SubagentStop" as const;

/** One Claude subagent-lifecycle signal, as the driver core read it. */
export interface ClaudeSubagentLifecycleSignal {
  /** Derived from the two wire-name constants so a rename is a compile error at every reader. */
  readonly signal: typeof CLAUDE_SUBAGENT_START_SIGNAL | typeof CLAUDE_SUBAGENT_STOP_SIGNAL;
  readonly subagentId: string;
  /** `parent_tool_use_id`, copied verbatim so the subagent tree pairs. */
  readonly parentToolUseId: string | null;
}

/** The normalized subagent-lifecycle emission plus its router registration. */
export interface ClaudeSubagentLifecycleNormalization {
  readonly category: EventCategory;
  readonly eventType: SessionEventType;
  readonly subagentId: string;
  readonly parentToolUseId: string | null;
  /**
   * The router announcement for a `SubagentStart`, naming the session's own thread as parent
   * (arrival in the parent's stream is the lineage); `null` for a `SubagentStop`.
   */
  readonly announcement: ChildThreadAnnouncement | null;
}

/**
 * Normalizes one subagent-lifecycle signal into `subagent.started` / `subagent.completed` and, for
 * a start, the router announcement. Claude has no thread-id member, so the subagent id is the
 * child thread id.
 */
export function normalizeClaudeSubagentLifecycle(
  lifecycleSignal: ClaudeSubagentLifecycleSignal,
  sessionThreadId: string,
): ClaudeSubagentLifecycleNormalization {
  if (lifecycleSignal.signal === CLAUDE_SUBAGENT_START_SIGNAL) {
    return Object.freeze({
      category: "tool_activity",
      eventType: "subagent.started",
      subagentId: lifecycleSignal.subagentId,
      parentToolUseId: lifecycleSignal.parentToolUseId,
      announcement: Object.freeze({
        childThreadId: lifecycleSignal.subagentId,
        declaredParentThreadId: sessionThreadId,
        subagentId: lifecycleSignal.subagentId,
      }),
    });
  }
  return Object.freeze({
    category: "tool_activity",
    eventType: "subagent.completed",
    subagentId: lifecycleSignal.subagentId,
    parentToolUseId: lifecycleSignal.parentToolUseId,
    announcement: null,
  });
}

/**
 * Classifies a frame kind's family for the thread-frame router; an unlisted kind is `unknown`,
 * never presumed connection-scoped. `observation` is required so no call site forgets it and
 * drops a child's usage; pass `{ cumulativeUsage: undefined }` when there is none.
 */
export function classifyClaudeFrameFamilyForRouting(
  frameKind: string,
  observation: { readonly cumulativeUsage: unknown },
): ThreadFrameFamilyClass {
  const kindClass = classifyClaudeFrameKindForRouting(frameKind);
  // Decided by what the frame carries: cumulative token readings ride content frames and no kind
  // is reserved for usage. Thread-scoped kinds only; an unclassified kind stays fail-closed.
  if (observation.cumulativeUsage != null && kindClass.scope === "thread") {
    return { scope: "thread", capability: "usage" };
  }
  return kindClass;
}

function classifyClaudeFrameKindForRouting(frameKind: string): ThreadFrameFamilyClass {
  switch (frameKind) {
    // Connection- and account-scoped, including the control channel (connection-level both ways).
    case "system/api_retry":
    case "system/api_error":
    case "system/rate_limit_event":
    case "system/init":
    case "system/worker_shutting_down":
    case "control_request/can_use_tool":
    case "control_request/elicitation":
    case "control_request/request_user_dialog":
    case "control_request/hook_callback":
    case "control_request/mcp_message":
    case "control_request/mcp_set_servers":
    case "control_request/interrupt":
    case "control_request/set_permission_mode":
    case "control_request/set_model":
    case "control_request/get_usage":
    case "control_request/get_context_usage":
    case "control_request/get_session_cost":
    case "control_request/list_models":
    case "control_request/get_binary_version":
    case "control_request/apply_flag_settings":
    case "control_request/rewind_files":
    case "control_response/success":
    case "control_response/error":
      return { scope: "connection" };
    // Thread-scoped usage: the compaction marker rides the thread it compacts.
    case "system/compact_boundary":
      return { scope: "thread", capability: "usage" };
    // Subagent lifecycle: thread-scoped; the start is also the router's registration input.
    case CLAUDE_SUBAGENT_START_SIGNAL:
    case CLAUDE_SUBAGENT_STOP_SIGNAL:
      return { scope: "thread", capability: "lifecycle" };
    // Thread-scoped content: the result terminals and the remaining system-channel subtypes.
    case "result/success":
    case "result/error_max_turns":
    case "result/error_max_budget_usd":
    case "result/error_during_execution":
    case "result/error_max_structured_output_retries":
    case "system/hook_started":
    case "system/hook_progress":
    case "system/hook_response":
    case "system/notification":
    case "system/files_persisted":
    case "system/tool_use_summary":
    case "system/memory_recall":
    case "system/local_command_output":
    case "system/task_progress":
      return { scope: "thread", capability: "content" };
    default:
      return { scope: "unknown" };
  }
}
