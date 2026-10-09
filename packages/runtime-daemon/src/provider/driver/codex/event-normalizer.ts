// Codex event normalizer: every method the Codex service sends a client, with how the thread-frame
// router scopes it and what the driver does with it. A row that emits names the session event it
// becomes; a row that reads states what reads it; a notification nothing reads is opted out at
// `initialize`, so the service never sends it. It parses no payload and touches no session state.
//
// The table holds the 84 server notifications and the 10 server requests of the Codex app-server
// protocol at `codex-cli 0.161.0`, as its generated schema names them. A notification outside it
// gets an `unmapped_wire_kind` diagnostic from `reportCodexFrameOutsideTable` as it arrives, never
// a silent drop; a request outside it is refused at the connection.

import { SESSION_EVENT_TYPES } from "@ai-sidekicks/contracts/event/session";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

import { isPlainObject } from "../../record-readers.js";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import type { DriverDiagnosticsEmitter } from "../diagnostics.js";
import type { ChildThreadAnnouncement, ThreadFrameFamilyClass } from "../../thread-frame-router.js";
import { resolveAdoptedEventTarget, type NormalizedEventKind } from "../../event-disposition.js";

/** Which root a frame arrives on: a request must be answered, a notification is not. */
type CodexInboundFrameTransport = "server-request" | "server-notification";

/**
 * What the driver does with one method: `emits` a session event, named by its normalized kind or
 * by its target where it has no kind; `reads` it for the driver's own state or the daemon's log;
 * or `optOut`, a notification nothing reads, which the service is asked never to send.
 */
type CodexFrameReading =
  | { readonly emits: NormalizedEventKind }
  | {
      readonly emitsEvent: {
        readonly category: EventCategory;
        readonly eventType: SessionEventType;
      };
    }
  | { readonly reads: string }
  | { readonly optOut: string };

/** One row of the table: the frame's root, its routing family and its reading. */
type CodexFrameRow = {
  readonly transport: CodexInboundFrameTransport;
  readonly family: ThreadFrameFamilyClass;
} & CodexFrameReading;

const CONNECTION: ThreadFrameFamilyClass = { scope: "connection" };
const LIFECYCLE: ThreadFrameFamilyClass = { scope: "thread", capability: "lifecycle" };
const CONTENT: ThreadFrameFamilyClass = { scope: "thread", capability: "content" };
const USAGE: ThreadFrameFamilyClass = { scope: "thread", capability: "usage" };
const ASK: ThreadFrameFamilyClass = { scope: "thread", capability: "interactive-request" };

function request(family: ThreadFrameFamilyClass, reading: CodexFrameReading): CodexFrameRow {
  return { transport: "server-request", family, ...reading };
}

function notification(family: ThreadFrameFamilyClass, reading: CodexFrameReading): CodexFrameRow {
  return { transport: "server-notification", family, ...reading };
}

const VOICE_CALL_READING = "a voice call's frames, routed by thread to that session's call";
const STREAMED_PROSE_READING = "the item's prose, streamed as stored pieces of its message";

// Keyed by method; a `Map` below, because the key is untrusted and an object lookup would resolve
// `__proto__`.
const CODEX_FRAME_ROWS: Readonly<Record<string, CodexFrameRow>> = {
  // Server requests. The three approval methods, the legacy pair and Codex's own approval of a
  // tool-server call are the approval card; a question and a tool server's question are the
  // questions card; `item/tool/call` is a daemon tool's call.
  "item/tool/call": request(ASK, { emits: "tool_start" }),
  "item/tool/requestUserInput": request(ASK, { emits: "user_input_request" }),
  "mcpServer/elicitation/request": request(ASK, { emits: "user_input_request" }),
  "item/commandExecution/requestApproval": request(ASK, { emits: "approval_request" }),
  "item/fileChange/requestApproval": request(ASK, { emits: "approval_request" }),
  "item/permissions/requestApproval": request(ASK, { emits: "approval_request" }),
  execCommandApproval: request(ASK, { emits: "approval_request" }),
  applyPatchApproval: request(ASK, { emits: "approval_request" }),
  "attestation/generate": request(CONNECTION, {
    reads: "declined at negotiation, so it is refused on the transport",
  }),
  "account/chatgptAuthTokens/refresh": request(CONNECTION, {
    reads: "credential brokering the driver does not do, so it is refused on the transport",
  }),

  // A turn's life and its items.
  "thread/started": notification(LIFECYCLE, { emits: "subagent_status" }),
  "turn/started": notification(LIFECYCLE, { emits: "turn_start" }),
  "turn/completed": notification(LIFECYCLE, { emits: "turn_complete" }),
  error: notification(LIFECYCLE, { emits: "error" }),
  "item/started": notification(CONTENT, { emits: "tool_start" }),
  "item/completed": notification(CONTENT, { emits: "tool_complete" }),
  "model/rerouted": notification(CONTENT, { emits: "model_rerouted" }),
  "model/safetyBuffering/updated": notification(LIFECYCLE, {
    reads: "Codex's safety hold on a turn, shown live on the run's state stream, never stored",
  }),
  "turn/plan/updated": notification(CONTENT, { reads: "the turn's live task list" }),
  "thread/settings/updated": notification(CONTENT, {
    reads: "the thread's declared output speed and each run's settled one",
  }),
  "thread/tokenUsage/updated": notification(USAGE, { reads: "metered by the usage accountant" }),
  "thread/compacted": notification(USAGE, { reads: "settles a compaction the person asked for" }),
  "thread/closed": notification(LIFECYCLE, {
    reads: "the service unloaded the conversation, which a move to another service waits for",
  }),
  "serverRequest/resolved": notification(ASK, {
    reads: "Codex settled a request itself, so its held answer is let go",
  }),
  "skills/changed": notification(CONNECTION, { reads: "the held command list is read again" }),
  "thread/goal/updated": notification(CONTENT, {
    emitsEvent: { category: "session_lifecycle", eventType: "session.goal_updated" },
  }),
  "thread/goal/cleared": notification(CONTENT, {
    emitsEvent: { category: "session_lifecycle", eventType: "session.goal_cleared" },
  }),
  "account/rateLimits/updated": notification(CONNECTION, {
    reads: "the account's latest usage-limit reading, read when a turn fails",
  }),

  // Codex's own reviewer at Reviewed.
  guardianWarning: notification(CONTENT, {
    emitsEvent: { category: "approval_flow", eventType: "moderation.review_flagged" },
  }),
  "autoApprovalReview/strictReviewRequired": notification(CONTENT, {
    emitsEvent: { category: "approval_flow", eventType: "moderation.review_flagged" },
  }),
  "item/autoApprovalReview/completed": notification(CONTENT, {
    emitsEvent: { category: "approval_flow", eventType: "approval.reviewer_denied" },
  }),
  "item/autoApprovalReview/started": notification(CONTENT, {
    optOut: "only a review's end records anything",
  }),

  // Notices: a warning and a deprecation are the provider's own warning, a config warning is a
  // setting Codex ignored.
  warning: notification(CONNECTION, { emits: "notification" }),
  deprecationNotice: notification(CONNECTION, { emits: "notification" }),
  configWarning: notification(CONNECTION, { emits: "notification" }),
  "turn/moderationMetadata": notification(CONTENT, {
    reads: "a moderation hint with no words, written to the daemon's log only",
  }),
  "model/verification": notification(CONTENT, {
    reads: "a notice no screen draws, written to the daemon's log",
  }),
  "modelProvider/authRecoveryStarted": notification(CONNECTION, {
    reads: "Codex recovering its own sign-in, written to the daemon's log",
  }),
  "modelProvider/authRecoveryCompleted": notification(CONNECTION, {
    reads: "Codex recovering its own sign-in, written to the daemon's log",
  }),
  "windows/worldWritableWarning": notification(CONNECTION, {
    reads: "a Windows folder warning, written to the daemon's log",
  }),

  // A voice call.
  "thread/realtime/started": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/itemAdded": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/item/started": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/item/transcript/delta": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/item/completed": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/transcript/delta": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/transcript/done": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/outputAudio/delta": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/sdp": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/error": notification(CONTENT, { reads: VOICE_CALL_READING }),
  "thread/realtime/closed": notification(CONTENT, { reads: VOICE_CALL_READING }),

  // Streamed pieces of what a completed item carries whole: the reply, its reasoning and a plan
  // stream as stored pieces of their message, a command's output to the running-commands stream.
  "item/agentMessage/delta": notification(CONTENT, { reads: STREAMED_PROSE_READING }),
  "item/plan/delta": notification(CONTENT, { reads: STREAMED_PROSE_READING }),
  "item/reasoning/summaryTextDelta": notification(CONTENT, { reads: STREAMED_PROSE_READING }),
  "item/reasoning/summaryPartAdded": notification(CONTENT, { reads: STREAMED_PROSE_READING }),
  "item/reasoning/textDelta": notification(CONTENT, { reads: STREAMED_PROSE_READING }),
  "item/commandExecution/outputDelta": notification(CONTENT, {
    reads: "a running command's live output, published to the running-commands stream",
  }),
  "item/commandExecution/terminalInteraction": notification(CONTENT, {
    optOut: "what Codex types into a running command adds nothing its completed item lacks",
  }),
  "item/fileChange/outputDelta": notification(CONTENT, {
    optOut: "Codex no longer sends it; a file change's patches arrive on its own items",
  }),
  "item/fileChange/patchUpdated": notification(CONTENT, {
    optOut:
      "sent only under Codex's `apply_patch_streaming_events` feature, still under development " +
      "and off; a file change's patches arrive on its own items",
  }),
  "item/mcpToolCall/progress": notification(CONTENT, {
    optOut: "a tool call's result arrives whole on its completed item",
  }),
  "turn/diff/updated": notification(CONTENT, {
    optOut: "each file change lands as its own patch, and a turn's changes are read from git",
  }),

  // State the daemon owns, or requests it never makes.
  "thread/status/changed": notification(LIFECYCLE, {
    optOut: "a thread's activity restates what its turn and ask frames say",
  }),
  "thread/archived": notification(LIFECYCLE, { optOut: "the daemon archives sessions itself" }),
  "thread/unarchived": notification(LIFECYCLE, { optOut: "the daemon archives sessions itself" }),
  "thread/deleted": notification(LIFECYCLE, { optOut: "a purge reads its delete's own answer" }),
  "thread/reverted": notification(CONTENT, { optOut: "a cut reads its revert's own answer" }),
  "thread/name/updated": notification(CONTENT, { optOut: "a session's title is the daemon's" }),
  "thread/attachment/updated": notification(CONTENT, {
    optOut: "the daemon attaches nothing through Codex",
  }),
  "thread/queue/changed": notification(CONTENT, { optOut: "the daemon's own queue is the record" }),
  "project/changed": notification(CONNECTION, {
    optOut: "repository and workspace bindings are the daemon's",
  }),
  "thread/project/updated": notification(CONTENT, {
    optOut: "repository and workspace bindings are the daemon's",
  }),
  "thread/environment/connected": notification(CONTENT, {
    optOut: "the daemon sees the service's liveness itself",
  }),
  "thread/environment/disconnected": notification(CONTENT, {
    optOut: "the daemon sees the service's liveness itself",
  }),
  "thread/prediction/updated": notification(CONTENT, {
    optOut: "the daemon offers no predicted next message",
  }),
  "hook/started": notification(CONTENT, {
    optOut: "the daemon's own hook program reports to the daemon",
  }),
  "hook/completed": notification(CONTENT, {
    optOut: "the daemon's own hook program reports to the daemon",
  }),
  "command/exec/outputDelta": notification(CONNECTION, {
    optOut: "the daemon runs no command through the service",
  }),
  "process/outputDelta": notification(CONTENT, {
    optOut: "the daemon starts no process through the service",
  }),
  "process/exited": notification(CONTENT, {
    optOut: "the daemon starts no process through the service",
  }),
  "mcpServer/oauthLogin/completed": notification(CONNECTION, {
    optOut: "the daemon signs in to no tool server through Codex",
  }),
  "mcpServer/startupStatus/updated": notification(CONNECTION, {
    optOut: "every tool server is served by the daemon, which knows its state",
  }),
  "mcpServer/event/stream/notification": notification(CONNECTION, {
    optOut: "every tool server is served by the daemon, which reads its events itself",
  }),
  "account/updated": notification(CONNECTION, {
    optOut: "the sign-in check reads the account when it asks",
  }),
  "account/gatewayOAuth/changed": notification(CONNECTION, {
    optOut: "the daemon runs no gateway sign-in",
  }),
  "account/login/completed": notification(CONNECTION, {
    optOut: "the daemon runs no sign-in through the service",
  }),
  "app/list/updated": notification(CONNECTION, { optOut: "the daemon lists no Codex apps" }),
  "remoteControl/status/changed": notification(CONNECTION, {
    optOut: "Codex's own remote control is not used",
  }),
  "externalAgentConfig/import/progress": notification(CONNECTION, {
    optOut: "the daemon imports no outside configuration",
  }),
  "externalAgentConfig/import/completed": notification(CONNECTION, {
    optOut: "the daemon imports no outside configuration",
  }),
  "fs/changed": notification(CONNECTION, { optOut: "the daemon watches no folder through Codex" }),
  "fuzzyFileSearch/sessionUpdated": notification(CONNECTION, {
    optOut: "the daemon's own matcher searches files",
  }),
  "fuzzyFileSearch/sessionCompleted": notification(CONNECTION, {
    optOut: "the daemon's own matcher searches files",
  }),
  "windowsSandbox/setupCompleted": notification(CONNECTION, {
    optOut: "the daemon never asks Codex to set up its Windows sandbox",
  }),
};

const CODEX_FRAME_ROW_BY_METHOD: ReadonlyMap<string, CodexFrameRow> = new Map(
  Object.entries(CODEX_FRAME_ROWS),
);

/**
 * Every notification the service is asked never to send, sent as `optOutNotificationMethods` at
 * `initialize`: the table's notifications less every one the driver reads.
 */
export const CODEX_OPT_OUT_NOTIFICATION_METHODS: readonly string[] = Object.freeze(
  [...CODEX_FRAME_ROW_BY_METHOD]
    .filter(([, row]) => row.transport === "server-notification" && "optOut" in row)
    .map(([method]) => method),
);

// Derived from the contracts roster, so it widens by itself when a variant lands.
const REGISTERED_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set(SESSION_EVENT_TYPES);

/**
 * Reports a notification the table cannot carry as it arrives: a method outside the table, an
 * opted-out notification that arrived anyway, or one whose event has no registered payload
 * variant. Each gets a `DriverDiagnosticRecord`; a method the table carries reports nothing.
 */
export function reportCodexFrameOutsideTable(
  nativeMethod: string,
  diagnostics: DriverDiagnosticsEmitter,
): void {
  const row = CODEX_FRAME_ROW_BY_METHOD.get(nativeMethod);
  if (row === undefined || "optOut" in row) {
    diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "unmapped_wire_kind",
      rawWireType: nativeMethod,
      dispositionReason:
        row === undefined
          ? "wire method outside the Codex inbound table; routed to the diagnostic branch, " +
            "never silently dropped"
          : "a notification the connection opted out of arrived anyway; routed to the " +
            "diagnostic branch, never silently dropped",
      details: {},
    });
    return;
  }
  if ("reads" in row) {
    return;
  }
  const { eventType } = "emits" in row ? resolveAdoptedEventTarget(row.emits) : row.emitsEvent;
  if (!REGISTERED_EVENT_TYPES.has(eventType)) {
    diagnostics.emit({
      provider: CODEX_DRIVER_NAME,
      kind: "payload_variant_pending",
      rawWireType: nativeMethod,
      dispositionReason:
        "the event this frame becomes has no registered payload variant, so nothing is built",
      details: { eventType },
    });
  }
}

/**
 * The value Codex puts in an elicitation's `_meta.codex_approval_kind` when the elicitation is its
 * own approval of a tool-server call rather than the server's question.
 */
const CODEX_TOOL_CALL_APPROVAL_KIND = "mcp_tool_call";

/** Whether an elicitation is Codex's own approval of a tool-server call; `params` is untrusted. */
export function isCodexToolCallApprovalElicitation(params: unknown): boolean {
  if (!isPlainObject(params)) {
    return false;
  }
  const meta = params["_meta"];
  return isPlainObject(meta) && meta["codex_approval_kind"] === CODEX_TOOL_CALL_APPROVAL_KIND;
}

/**
 * The method's routing family for the thread-frame router: connection-scoped families need no
 * thread identity, thread-scoped ones demand one, and a method outside the table is `unknown`.
 */
export function classifyCodexFrameFamilyForRouting(nativeMethod: string): ThreadFrameFamilyClass {
  return CODEX_FRAME_ROW_BY_METHOD.get(nativeMethod)?.family ?? { scope: "unknown" };
}

/** The `thread/started` method: the thread-frame router's registration input. */
export const CODEX_THREAD_STARTED_METHOD = "thread/started";

/** The `thread/tokenUsage/updated` method, metered by the usage accountant. */
export const CODEX_THREAD_TOKEN_USAGE_METHOD = "thread/tokenUsage/updated";

/** The `turn/started` method, which opens a turn's boundary. */
export const CODEX_TURN_STARTED_METHOD = "turn/started";

/**
 * The `turn/completed` method, the terminal signal for a session and its children (there is no
 * `thread/ended` frame).
 */
export const CODEX_TURN_COMPLETED_METHOD = "turn/completed";

/** The `item/started` method, which names its turn; a run's output speed settles on the first. */
export const CODEX_ITEM_STARTED_METHOD = "item/started";

/** The `item/completed` method: the end of one step of a turn. */
export const CODEX_ITEM_COMPLETED_METHOD = "item/completed";

/** The `thread/compacted` method, which settles a compaction the person asked for. */
export const CODEX_THREAD_COMPACTED_METHOD = "thread/compacted";

/** The `skills/changed` method, on which the held command list is read again. */
export const CODEX_SKILLS_CHANGED_METHOD = "skills/changed";

/** The `thread/settings/updated` method, which declares the thread's output speed. */
export const CODEX_THREAD_SETTINGS_UPDATED_METHOD = "thread/settings/updated";

/**
 * The `ThreadSourceKind` arms that mark a provider-attributed subagent child, whose spend is
 * attributed by (`runId`, `provider`, `subagentId`). The other arm, `subAgentCompact`, is a
 * compaction thread whose spend attributes to the parent run.
 */
const CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS: readonly string[] = Object.freeze([
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
