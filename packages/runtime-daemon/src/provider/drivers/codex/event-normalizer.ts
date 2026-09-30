// Codex event normalizer: answers "which normalized event family does this native frame belong
// to". It parses no payload, builds no envelope and touches no session state.
//
// The table covers the server-originated JSON-RPC methods of the pinned `codex-cli 0.150.1`
// app-server protocol, named as its generated schema names them.
//
// - Not mapped: the eleven `thread/realtime/*` notifications (opted out by name in
//   `./lifecycle.ts`), the experimental `mcpServer/event/stream/notification`, and replies to
//   daemon-issued requests such as `account/rateLimits/read`.
// - `artifact_publication` has no row: no Codex frame maps to it. `turn/diff/updated` is a
//   `tool.result` row.
// - An unmapped method throws `UnknownCodexInboundFrameError`; `resolveCodexFrameEmissionRoute`
//   emits an `unmapped_wire_kind` diagnostic instead. Neither drops the frame silently.

import {
  SESSION_EVENT_TYPES,
  type EventCategory,
  type SessionEventType,
} from "@ai-sidekicks/contracts";
import type { DriverDiagnosticRecord, DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
import type { ChildThreadAnnouncement, ThreadFrameFamilyClass } from "../../thread-frame-router.js";
import type { CodexToolName } from "./tools.js";
import type { NormalizedEventKind } from "../../event-disposition.js";

/**
 * Which server-originated JSON-RPC root a frame arrives on: a `server-request` must be answered, a
 * `server-notification` is fire-and-forget.
 */
export type CodexInboundFrameTransport = "server-request" | "server-notification";

/**
 * Every server-originated method of the pinned Codex protocol that has a normalized disposition;
 * the backing record's `satisfies` check makes a missing or extra row a build error.
 */
export type CodexInboundFrameMethod =
  | "item/tool/call"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval"
  | "attestation/generate"
  | "account/chatgptAuthTokens/refresh"
  | "error"
  | "warning"
  | "configWarning"
  | "deprecationNotice"
  | "guardianWarning"
  | "thread/goal/updated"
  | "thread/goal/cleared"
  | "account/rateLimits/updated"
  | "thread/compacted"
  // Not experimental-gated, so delivered to this driver's `experimentalApi: false` connection.
  | "skills/changed"
  | "item/autoApprovalReview/started"
  | "item/autoApprovalReview/completed"
  | "model/safetyBuffering/updated"
  // Experimental-gated, so not delivered at `experimentalApi: false`; see
  // {@link CODEX_NEGOTIATION_GATED_METHODS}.
  | "process/outputDelta"
  | "process/exited"
  | "turn/moderationMetadata"
  | "autoApprovalReview/strictReviewRequired"
  | "thread/reverted"
  | "thread/queue/changed"
  | "project/changed"
  | "thread/project/updated"
  | "thread/environment/connected"
  | "thread/environment/disconnected"
  | "thread/settings/updated"
  // The generated schema names these `turn/diff/updated` and `turn/plan/updated`, not `turn/diff`.
  | "turn/diff/updated"
  | "turn/plan/updated";

/**
 * Mapped methods that cannot arrive at `experimentalApi: false`: the provider's transport silently
 * drops the eleven notifications, and `item/tool/requestUserInput` is the one experimental request
 * arm. Declared, not derived, since the schema carries no notification-side marker at the pin.
 */
export const CODEX_NEGOTIATION_GATED_METHODS: readonly CodexInboundFrameMethod[] = Object.freeze([
  "item/tool/requestUserInput",
  "process/outputDelta",
  "process/exited",
  "turn/moderationMetadata",
  "autoApprovalReview/strictReviewRequired",
  "thread/reverted",
  "thread/queue/changed",
  "project/changed",
  "thread/project/updated",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
]);

/** The wire shape `item/<toolName>/requestApproval`, the segment taken from `CodexToolName`. */
type CodexToolApprovalMethod<TToolName extends CodexToolName> = `item/${TToolName}/requestApproval`;

/**
 * The approval methods whose middle segment is a `CodexToolName`; renaming a tool in
 * `CODEX_TOOL_NAMES` or dropping a method from the union is a compile error. Only the two
 * mutating tools gate on approval.
 */
export const CODEX_TOOL_KEYED_APPROVAL_METHODS: readonly (CodexToolApprovalMethod<CodexToolName> &
  CodexInboundFrameMethod)[] = Object.freeze([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

/**
 * Whether a row's target event type has a payload variant registered in `SessionEventSchema`;
 * `payload-variant-pending` rows go to diagnostics, never to an envelope builder.
 */
export type CodexEmissionReadiness = "envelope-constructible" | "payload-variant-pending";

// Derived from the contracts roster, so it widens by itself when a variant lands.
const REGISTERED_PAYLOAD_VARIANT_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set(
  SESSION_EVENT_TYPES,
);

/** Says whether `eventType` may be built into a `SessionEvent` envelope today. */
export function resolveCodexEmissionReadiness(eventType: SessionEventType): CodexEmissionReadiness {
  return REGISTERED_PAYLOAD_VARIANT_EVENT_TYPES.has(eventType)
    ? "envelope-constructible"
    : "payload-variant-pending";
}

/**
 * A frame that normalizes into one family and names the event type it emits. `normalizedKind` is
 * `null` for a member with no census kind (such as `thread/goal/updated`); `emissionReadiness`
 * is derived when the map is built, never stated per row.
 */
export interface CodexNormalizedFamilyEmission {
  readonly disposition: "normalized";
  readonly nativeMethod: CodexInboundFrameMethod;
  readonly transport: CodexInboundFrameTransport;
  readonly family: EventCategory;
  readonly eventType: SessionEventType;
  readonly normalizedKind: NormalizedEventKind | null;
  readonly emissionReadiness: CodexEmissionReadiness;
}

/**
 * A known frame with no session-timeline capability, so no family. The `reason` is required so a
 * non-emission is always justified; an unknown method throws instead.
 */
interface CodexNotEventedFrameDisposition {
  readonly disposition: "not-evented";
  readonly nativeMethod: CodexInboundFrameMethod;
  readonly transport: CodexInboundFrameTransport;
  readonly reason: string;
  readonly family?: never;
  readonly eventType?: never;
  readonly normalizedKind?: never;
  readonly emissionReadiness?: never;
}

/** The total result of normalizing one pinned Codex inbound frame method. */
export type CodexFrameNormalization =
  | CodexNormalizedFamilyEmission
  | CodexNotEventedFrameDisposition;

// A row before `emissionReadiness` is derived onto it. Stating the readiness by hand is a compile
// error (TS2353), but only for fresh object literals, which every row here is.
type CodexFrameNormalizationTableRow =
  | Omit<CodexNormalizedFamilyEmission, "emissionReadiness">
  | CodexNotEventedFrameDisposition;

/**
 * Thrown when a Codex inbound method resolves to no census row. `nativeMethod` is untrusted data,
 * never interpolated into anything that executes.
 */
export class UnknownCodexInboundFrameError extends Error {
  readonly nativeMethod: string;

  constructor(nativeMethod: string) {
    super(
      `Unmapped Codex inbound frame method: ${JSON.stringify(nativeMethod)}. ` +
        "The pinned census does not cover it; the daemon diagnostic default branch " +
        "replaces this refusal on the routed normalize path.",
    );
    this.name = "UnknownCodexInboundFrameError";
    this.nativeMethod = nativeMethod;
  }
}

// Keyed by the closed union, so a missing or extra method is a compile error.
const CODEX_FRAME_NORMALIZATION_RECORD = {
  "item/tool/call": {
    disposition: "normalized",
    nativeMethod: "item/tool/call",
    transport: "server-request",
    family: "tool_activity",
    eventType: "tool.invoked",
    normalizedKind: "tool_start",
  },
  // Experimental-gated: the gate decides delivery, this table decides disposition.
  "item/tool/requestUserInput": {
    disposition: "normalized",
    nativeMethod: "item/tool/requestUserInput",
    transport: "server-request",
    family: "interactive_request",
    eventType: "question.asked",
    normalizedKind: "user_input_request",
  },
  // A tool server's question (an MCP elicitation) becomes the same question record.
  "mcpServer/elicitation/request": {
    disposition: "normalized",
    nativeMethod: "mcpServer/elicitation/request",
    transport: "server-request",
    family: "interactive_request",
    eventType: "question.asked",
    normalizedKind: "user_input_request",
  },
  // Each permission ask is recorded once as `approval.requested`; the provider's request id only
  // routes the answer back, and the daemon mints the resolution from its own adjudication.
  "item/commandExecution/requestApproval": {
    disposition: "normalized",
    nativeMethod: "item/commandExecution/requestApproval",
    transport: "server-request",
    family: "approval_flow",
    eventType: "approval.requested",
    normalizedKind: "approval_request",
  },
  "item/fileChange/requestApproval": {
    disposition: "normalized",
    nativeMethod: "item/fileChange/requestApproval",
    transport: "server-request",
    family: "approval_flow",
    eventType: "approval.requested",
    normalizedKind: "approval_request",
  },
  "item/permissions/requestApproval": {
    disposition: "normalized",
    nativeMethod: "item/permissions/requestApproval",
    transport: "server-request",
    family: "approval_flow",
    eventType: "approval.requested",
    normalizedKind: "approval_request",
  },
  execCommandApproval: {
    disposition: "normalized",
    nativeMethod: "execCommandApproval",
    transport: "server-request",
    family: "approval_flow",
    eventType: "approval.requested",
    normalizedKind: "approval_request",
  },
  applyPatchApproval: {
    disposition: "normalized",
    nativeMethod: "applyPatchApproval",
    transport: "server-request",
    family: "approval_flow",
    eventType: "approval.requested",
    normalizedKind: "approval_request",
  },
  // Control-plane requests answered on the transport; adopting either would put a handshake on the
  // timeline.
  "attestation/generate": {
    disposition: "not-evented",
    nativeMethod: "attestation/generate",
    transport: "server-request",
    reason:
      "control-plane request answered on the transport (the initialize-declared requestAttestation capability, codex.md); it asks the daemon to mint an attestation and carries no session observation, so it has no timeline capability to lose",
  },
  "account/chatgptAuthTokens/refresh": {
    disposition: "not-evented",
    nativeMethod: "account/chatgptAuthTokens/refresh",
    transport: "server-request",
    reason:
      "credential-refresh brokering answered on the transport (provider-account plane, which stores no credential material); routing a credential frame onto the session timeline would put an auth-plane event in the audit log and is exactly what that plane's un-evented posture forbids",
  },
  error: {
    disposition: "normalized",
    nativeMethod: "error",
    transport: "server-notification",
    family: "run_lifecycle",
    eventType: "run.failed",
    normalizedKind: "error",
  },
  // Notices that drive no state transition (kind `notification`). `warning` and `deprecationNotice`
  // are notice kind `provider_warning`; `configWarning` is `settings_ignored`.
  warning: {
    disposition: "normalized",
    nativeMethod: "warning",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },
  configWarning: {
    disposition: "normalized",
    nativeMethod: "configWarning",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },
  deprecationNotice: {
    disposition: "normalized",
    nativeMethod: "deprecationNotice",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.notice",
    normalizedKind: "notification",
  },
  // Codex's own reviewer: `guardianWarning` and `autoApprovalReview/strictReviewRequired` are one
  // system message in Codex's words. A review that blocked an action is `approval.reviewer_denied`.
  // None records a daemon adjudication, so none bypasses the approval pipeline.
  guardianWarning: {
    disposition: "normalized",
    nativeMethod: "guardianWarning",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },
  "thread/goal/updated": {
    disposition: "normalized",
    nativeMethod: "thread/goal/updated",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.goal_updated",
    normalizedKind: null,
  },
  "thread/goal/cleared": {
    disposition: "normalized",
    nativeMethod: "thread/goal/cleared",
    transport: "server-notification",
    family: "session_lifecycle",
    eventType: "session.goal_cleared",
    normalizedKind: null,
  },
  // Account-quota utilization, kept apart from context-window telemetry.
  "account/rateLimits/updated": {
    disposition: "normalized",
    nativeMethod: "account/rateLimits/updated",
    transport: "server-notification",
    family: "usage_telemetry",
    eventType: "usage.rate_limit_update",
    normalizedKind: "rate_limits",
  },
  // Provider context-window compaction, not the daemon's `event.compacted` retention pass.
  "thread/compacted": {
    disposition: "normalized",
    nativeMethod: "thread/compacted",
    transport: "server-notification",
    family: "usage_telemetry",
    eventType: "usage.context_compacted",
    normalizedKind: "compact_boundary",
  },
  // Not evented: an empty invalidation signal to re-run `skills/list`; the one consequence the
  // daemon owns, discarding the held enumeration, is state it already has.
  "skills/changed": {
    disposition: "not-evented",
    nativeMethod: "skills/changed",
    transport: "server-notification",
    reason:
      "empty-payload invalidation signal for the provider's local skill-file watch; it carries no session observation to lose, and its only consequence — discarding the driver-held command enumeration so the next read re-reads in full — is daemon-side state the provider is telling the client to refresh",
  },
  // Only the review's completion is evented, not its start.
  "item/autoApprovalReview/started": {
    disposition: "not-evented",
    nativeMethod: "item/autoApprovalReview/started",
    transport: "server-notification",
    reason:
      "the start of Codex's own auto-approval review; only the review's completion records anything (a denied or timed-out review is the reviewer's block), so the start goes to the daemon's log only",
  },
  // A denied or timed-out review is the reviewer's block; the daemon seals Codex's review with the
  // row so `Allow once` can send it back.
  "item/autoApprovalReview/completed": {
    disposition: "normalized",
    nativeMethod: "item/autoApprovalReview/completed",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "approval.reviewer_denied",
    normalizedKind: null,
  },
  // Codex holding a turn for a safety check: the frame belongs to that turn's run and reaches the
  // screen on the run's state stream, not as a session row.
  "model/safetyBuffering/updated": {
    disposition: "not-evented",
    nativeMethod: "model/safetyBuffering/updated",
    transport: "server-notification",
    reason:
      "Codex's safety hold on a running turn is a live detail of the run's working status: it is relayed on the run's state stream as the hold frame and never written to the session's history, so a re-opened session does not replay it",
  },
  // `process/*` frames land in `tool.result`; output and exit differ only in kind.
  "process/outputDelta": {
    disposition: "normalized",
    nativeMethod: "process/outputDelta",
    transport: "server-notification",
    family: "tool_activity",
    eventType: "tool.result",
    normalizedKind: "command_output",
  },
  "process/exited": {
    disposition: "normalized",
    nativeMethod: "process/exited",
    transport: "server-notification",
    family: "tool_activity",
    eventType: "tool.result",
    normalizedKind: "command_exit",
  },
  "turn/moderationMetadata": {
    disposition: "not-evented",
    nativeMethod: "turn/moderationMetadata",
    transport: "server-notification",
    reason:
      "a moderation display hint with no words, which Codex's own app does not draw; it goes to the daemon's log only",
  },
  "autoApprovalReview/strictReviewRequired": {
    disposition: "normalized",
    nativeMethod: "autoApprovalReview/strictReviewRequired",
    transport: "server-notification",
    family: "approval_flow",
    eventType: "moderation.review_flagged",
    normalizedKind: null,
  },

  // Gated and not-evented: each echoes a record the daemon already owns, and adopting it would
  // record the same fact twice.
  "thread/reverted": {
    disposition: "not-evented",
    nativeMethod: "thread/reverted",
    transport: "server-notification",
    reason:
      'correlation-only wire echo, not an empty frame — it is the notification counterpart of `thread/revert`, which the V1 driver does not drive at all: binds the Codex rewind to `thread/fork` at an inclusive `lastTurnId` (amended 2026-08-26), and `thread/revert` is separately `#[experimental("thread/revert")]` and paginated-threads-only at the pin, so this frame is off the V1 rewind path rather than on its hot path. Where it does arrive it correlates a revert the daemon requested, and the rewind-confirmation consumer is the lifecycle leg, not the timeline: the durable rollback record is daemon-emitted (`run.rolled_back`) when the daemon settles the intervention, so adopting this echo would mint a second record of a boundary the daemon already owns and could report a rollback the daemon refused',
  },
  "thread/queue/changed": {
    disposition: "not-evented",
    nativeMethod: "thread/queue/changed",
    transport: "server-notification",
    reason:
      "provider-side queue-depth notice; the daemon's own queue is the authority and already emits the `queue_item.*` interactive_request rows, so this frame carries no capability the timeline lacks",
  },
  "project/changed": {
    disposition: "not-evented",
    nativeMethod: "project/changed",
    transport: "server-notification",
    reason:
      "Codex project-scope bookkeeping; repo and workspace binding is daemon-owned (`repo.*` / `workspace.*` session_lifecycle rows sourced from the daemon's own mount state), so a provider-authored project notice would be a second source of truth for a binding the daemon set",
  },
  "thread/project/updated": {
    disposition: "not-evented",
    nativeMethod: "thread/project/updated",
    transport: "server-notification",
    reason:
      "per-thread projection of the same Codex project-scope bookkeeping as `project/changed`; same daemon-owned-binding reason",
  },
  "thread/environment/connected": {
    disposition: "not-evented",
    nativeMethod: "thread/environment/connected",
    transport: "server-notification",
    reason:
      "Codex environment-connection bookkeeping; machine liveness is daemon-owned and is " +
      "observed by the daemon that spawned the process, so a provider-reported connection " +
      "would report liveness the daemon can see directly",
  },
  "thread/environment/disconnected": {
    disposition: "not-evented",
    nativeMethod: "thread/environment/disconnected",
    transport: "server-notification",
    reason:
      "the paired disconnect of `thread/environment/connected`; same daemon-owned-liveness reason, and the run-terminal consequence of a real disconnect reaches the timeline through the lifecycle module's terminal emission rather than through this notice",
  },
  "thread/settings/updated": {
    disposition: "not-evented",
    nativeMethod: "thread/settings/updated",
    transport: "server-notification",
    reason:
      "provider-side settings echo; agent configuration is daemon-owned and settles as `agent.provider_binding_changed` when the daemon applies it, so adopting the echo would double-record a mutation the daemon authored",
  },
  // The diff is a `tool.result` row (kind `diff`), not `artifact_publication`.
  "turn/diff/updated": {
    disposition: "normalized",
    nativeMethod: "turn/diff/updated",
    transport: "server-notification",
    family: "tool_activity",
    eventType: "tool.result",
    normalizedKind: "diff",
  },
  // A proposed plan is an `assistant.message` row (kind `proposed_plan`).
  "turn/plan/updated": {
    disposition: "normalized",
    nativeMethod: "turn/plan/updated",
    transport: "server-notification",
    family: "assistant_output",
    eventType: "assistant.message",
    normalizedKind: "proposed_plan",
  },
} as const satisfies Record<CodexInboundFrameMethod, CodexFrameNormalizationTableRow>;

/** The census as an iterable list, derived from the record's keys. */
export const CODEX_INBOUND_FRAME_METHODS: readonly CodexInboundFrameMethod[] = Object.freeze(
  Object.keys(CODEX_FRAME_NORMALIZATION_RECORD) as CodexInboundFrameMethod[],
);

/**
 * The mapping from native method to normalized family. A `Map` because the key is an untrusted
 * string and an object lookup would resolve `__proto__`; entries are frozen singletons.
 */
export const CODEX_FRAME_NORMALIZATION_BY_METHOD: ReadonlyMap<
  CodexInboundFrameMethod,
  CodexFrameNormalization
> = new Map(
  // Sound: the record's keys are exactly the `CodexInboundFrameMethod` literals.
  (
    Object.entries(CODEX_FRAME_NORMALIZATION_RECORD) as ReadonlyArray<
      [CodexInboundFrameMethod, CodexFrameNormalizationTableRow]
    >
  ).map(([nativeMethod, normalization]) => [
    nativeMethod,
    Object.freeze(
      normalization.disposition === "normalized"
        ? {
            ...normalization,
            emissionReadiness: resolveCodexEmissionReadiness(normalization.eventType),
          }
        : normalization,
    ),
  ]),
);

// The driver core uses `resolveCodexFrameEmissionRoute`, which emits a diagnostic instead.
function refuseUnmappedCodexInboundFrame(nativeMethod: string): never {
  throw new UnknownCodexInboundFrameError(nativeMethod);
}

/**
 * Normalizes one Codex inbound method into its family disposition (the identical frozen
 * singleton for the same input). Throws {@link UnknownCodexInboundFrameError} if it is unmapped.
 */
export function normalizeCodexInboundFrame(nativeMethod: string): CodexFrameNormalization {
  const normalization = CODEX_FRAME_NORMALIZATION_BY_METHOD.get(
    nativeMethod as CodexInboundFrameMethod,
  );
  if (normalization === undefined) {
    refuseUnmappedCodexInboundFrame(nativeMethod);
  }
  return normalization;
}

/** The census-mapped emission answer, or the frame's routed diagnostic. */
export type CodexFrameEmissionRoute =
  | { readonly route: "emit"; readonly normalization: CodexNormalizedFamilyEmission }
  | { readonly route: "not-evented"; readonly normalization: CodexNotEventedFrameDisposition }
  | { readonly route: "diagnostic"; readonly record: DriverDiagnosticRecord };

/**
 * The driver core's entry point; never throws. A method outside the census or a target without a
 * registered payload variant emits a `DriverDiagnosticRecord` and routes to `diagnostic`, never to
 * an envelope.
 */
export function resolveCodexFrameEmissionRoute(
  nativeMethod: string,
  diagnostics: DriverDiagnosticsEmitter,
): CodexFrameEmissionRoute {
  const normalization = CODEX_FRAME_NORMALIZATION_BY_METHOD.get(
    nativeMethod as CodexInboundFrameMethod,
  );
  if (normalization === undefined) {
    const record: DriverDiagnosticRecord = {
      provider: "codex",
      kind: "unmapped_wire_kind",
      rawWireType: nativeMethod,
      dispositionReason:
        "wire method outside the pinned Codex inbound census; routed to the daemon diagnostic default branch, never silently dropped and never forced into an envelope",
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
      provider: "codex",
      kind: "payload_variant_pending",
      rawWireType: nativeMethod,
      dispositionReason:
        "censused kind whose target SessionEventType has no registered SessionEventSchema payload variant; envelope construction is forbidden without one, so the frame routes to the diagnostic branch",
      details: { eventType: normalization.eventType },
    };
    diagnostics.emit(record);
    return { route: "diagnostic", record };
  }
  return { route: "emit", normalization };
}

/** The `thread/started` method: the thread-frame router's registration input, not a table row. */
export const CODEX_THREAD_STARTED_METHOD = "thread/started" as const;

/** The `thread/tokenUsage/updated` method, metered by the usage accountant; not a table row. */
export const CODEX_THREAD_TOKEN_USAGE_METHOD = "thread/tokenUsage/updated" as const;

/** The `turn/started` method, classified for routing but not a table row. */
const CODEX_TURN_STARTED_METHOD = "turn/started" as const;

/**
 * The `turn/completed` method, the terminal signal for a session and its children (the pin has no
 * `thread/ended` frame). Not a table row.
 */
export const CODEX_TURN_COMPLETED_METHOD = "turn/completed" as const;

/** The `thread/compacted` method; `./lifecycle.ts` compares against this symbol. */
export const CODEX_THREAD_COMPACTED_METHOD = "thread/compacted" as const;

/** The `skills/changed` method; `./lifecycle.ts` compares against this symbol. */
export const CODEX_SKILLS_CHANGED_METHOD = "skills/changed" as const;

/**
 * The `ThreadSourceKind` arms that mark a provider-attributed subagent child, whose spend is
 * attributed by (`runId`, `provider`, `subagentId`). The other arm, `subAgentCompact`, is a
 * compaction thread whose spend attributes to the parent run.
 */
export const CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS: readonly string[] = Object.freeze([
  "subAgent",
  "subAgentReview",
  "subAgentThreadSpawn",
  "subAgentOther",
]);

/**
 * Derives the router's `ChildThreadAnnouncement` from a `thread/started` notification. The child
 * thread id doubles as the subagent identity on subagent-attributed kinds; a compaction child has
 * none, so its spend attributes to the parent run.
 */
export function deriveCodexChildThreadAnnouncement(threadStarted: {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly threadSourceKind: string;
}): ChildThreadAnnouncement {
  const subagentAttributed = CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS.includes(
    threadStarted.threadSourceKind,
  );
  return {
    childThreadId: threadStarted.threadId,
    declaredParentThreadId: threadStarted.parentThreadId,
    subagentId: subagentAttributed ? threadStarted.threadId : null,
  };
}

/**
 * Classifies a method's family for the thread-frame router: connection-scoped families need no
 * thread identity, thread-scoped ones demand one, and an unlisted method is `unknown`.
 */
export function classifyCodexFrameFamilyForRouting(nativeMethod: string): ThreadFrameFamilyClass {
  switch (nativeMethod) {
    // `skills/changed` is listed because an unlisted method is quarantined, which would emit a
    // `thread_frame_quarantined` diagnostic on every save of a watched skill file.
    case "error":
    case "warning":
    case "configWarning":
    case "deprecationNotice":
    case "guardianWarning":
    case "account/rateLimits/updated":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case CODEX_SKILLS_CHANGED_METHOD:
      return { scope: "connection" };
    case CODEX_THREAD_TOKEN_USAGE_METHOD:
    case CODEX_THREAD_COMPACTED_METHOD:
      return { scope: "thread", capability: "usage" };
    // `turn/completed` must be classified here, or it would be quarantined instead of reaching the
    // emission gate, which admits only a `project` route.
    case CODEX_THREAD_STARTED_METHOD:
    case CODEX_TURN_STARTED_METHOD:
    case CODEX_TURN_COMPLETED_METHOD:
    case "model/safetyBuffering/updated":
      return { scope: "thread", capability: "lifecycle" };
    case "item/tool/call":
    case "item/tool/requestUserInput":
    case "mcpServer/elicitation/request":
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "execCommandApproval":
    case "applyPatchApproval":
      return { scope: "thread", capability: "interactive-request" };
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "process/outputDelta":
    case "process/exited":
    case "turn/moderationMetadata":
    case "autoApprovalReview/strictReviewRequired":
    case "thread/reverted":
    case "thread/queue/changed":
    case "thread/project/updated":
    case "thread/environment/connected":
    case "thread/environment/disconnected":
    case "thread/settings/updated":
    case "turn/diff/updated":
    case "turn/plan/updated":
      return { scope: "thread", capability: "content" };
    // Project-level bookkeeping rides the connection, not a thread.
    case "project/changed":
      return { scope: "connection" };
    default:
      return { scope: "unknown" };
  }
}
