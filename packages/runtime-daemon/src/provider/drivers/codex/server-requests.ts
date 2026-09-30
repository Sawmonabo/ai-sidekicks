/**
 * The requests the Codex app server sends to the client: which methods are routed to a person,
 * the descriptors that read them, and the decisions and responders that answer them.
 */

import { type RunId, type SessionId } from "@ai-sidekicks/contracts";
import type { ProviderAskOption } from "./ask-option-sets.js";

/**
 * Ceiling on one unterminated inbound line (UTF-16 code units, since counting bytes rescans the
 * tail on every chunk) and on one outbound frame (UTF-8 bytes; the provider publishes no limit).
 * It stops a peer that never sends a newline from growing the buffer until the daemon dies.
 */
export const CODEX_MAX_LINE_LENGTH: number = 32 * 1024 * 1024;

/**
 * The refusal reason substituted for an answer too large for the wire: a constant, so it cannot
 * itself exceed the bound. The answer is refused, never truncated (a truncated tool output reads
 * as complete), and the loss is recorded on both diagnostic sinks.
 */
export const CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON: string =
  "The daemon composed an answer larger than this transport will send; refusing rather than delivering a truncated result.";

/**
 * Bound on a provider `turnId` before it enters a refusal reason or diagnostic; matches
 * `DRIVER_TOOL_CALL_ID_MAX_LEN`, the same kind of opaque handle.
 */
const CODEX_ROUTED_ASK_TURN_ID_MAX_LEN = 256;

/**
 * The ten server-initiated request methods of the pinned protocol (`ServerRequest` union at
 * `codex-cli 0.150.1`; regenerate, do not transcribe). An observability annotation, not a routing
 * filter: routing is keyed on the descriptors below, and any other method gets `-32601`.
 */
export const CODEX_SERVER_REQUEST_METHODS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
]);

// Server-request routing: this table connects inbound asks to the normalizer's
// `approval.requested`, `question.asked` and `tool.invoked`; otherwise every method+id frame gets
// `-32601`.
// Routed: `item/tool/call`, the three modern approval methods, the legacy pair (routed so the
// answer does not depend on the provider's spelling) and `mcpServer/elicitation/request`.
// Unrouted, so `-32601`: `item/tool/requestUserInput` (experimental, unreachable at
// `experimentalApi: false`), `attestation/generate` (declined at negotiation) and
// `account/chatgptAuthTokens/refresh` (credential brokering this driver does not do).
// Fail-closed: a routed method with no responder, a refusing one or a throwing one answers with
// the method's own refusal shape, never `-32601` (a protocol error where a decision was asked) and
// never silence (which hangs the turn).

/** The provider result for one answered ask, composed by its own descriptor. */
export type CodexServerRequestResult = Record<string, unknown>;

/** One routed server-request method and the two answers it can carry. */
export interface CodexRoutedServerRequestDescriptor {
  /** Which host answers the ask: the callback-tool host, or the approval evaluation seam. */
  readonly askKind: "callback-tool" | "approval";
  /**
   * The allowed answer. `payload` carries data the daemon supplies (a granted permission profile,
   * an elicitation's content) and is merged, not substituted for the decision member.
   */
  readonly composeAllowedResult: (
    payload: Readonly<Record<string, unknown>> | undefined,
  ) => CodexServerRequestResult;
  /** The refusal answer. Never carries data: a refusal grants nothing. */
  readonly composeRefusedResult: (reason: string) => CodexServerRequestResult;
}

/**
 * The routed methods and their answer shapes, read from the pinned response types. A refusal
 * answers `decline` or `denied`, never `cancel` or `abort`, which would interrupt the turn.
 * Permissions has no decline arm, so its refusal is an empty grant.
 */
export const CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS: ReadonlyMap<
  string,
  CodexRoutedServerRequestDescriptor
> = new Map<string, CodexRoutedServerRequestDescriptor>([
  [
    "item/tool/call",
    {
      askKind: "callback-tool",
      composeAllowedResult: (payload) => ({
        success: true,
        contentItems: readContentItems(payload),
      }),
      composeRefusedResult: (reason) => ({
        success: false,
        contentItems: [{ type: "inputText", text: reason }],
      }),
    },
  ],
  [
    "item/commandExecution/requestApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "accept" }),
      composeRefusedResult: () => ({ decision: "decline" }),
    },
  ],
  [
    "item/fileChange/requestApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "accept" }),
      composeRefusedResult: () => ({ decision: "decline" }),
    },
  ],
  [
    "item/permissions/requestApproval",
    {
      askKind: "approval",
      // The granted profile is the daemon's to compose, so an allowed answer with no supplied
      // profile grants nothing rather than guessing a widening.
      composeAllowedResult: (payload) => ({
        permissions: readGrantedPermissionProfile(payload),
        scope: "turn",
      }),
      composeRefusedResult: () => ({ permissions: {}, scope: "turn" }),
    },
  ],
  [
    "execCommandApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "approved" }),
      composeRefusedResult: (reason) => ({ decision: { denied: { rejection: reason } } }),
    },
  ],
  [
    "applyPatchApproval",
    {
      askKind: "approval",
      composeAllowedResult: () => ({ decision: "approved" }),
      composeRefusedResult: (reason) => ({ decision: { denied: { rejection: reason } } }),
    },
  ],
  [
    "mcpServer/elicitation/request",
    {
      askKind: "approval",
      composeAllowedResult: (payload) =>
        payload === undefined ? { action: "accept" } : { action: "accept", content: payload },
      composeRefusedResult: () => ({ action: "decline" }),
    },
  ],
]);

/** The routed method names, for the responder port. */
export const CODEX_ROUTED_SERVER_REQUEST_METHODS: readonly string[] = Object.freeze([
  ...CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.keys(),
]);

/**
 * Why no callback-tool registration is attempted: `dynamicTools` is experimental-only in
 * `ThreadStartParams` (`codex-cli 0.150.1`: 15 properties, 26 under `--experimental`), and
 * `experimentalApi` would also un-dormant experimental frames the normalizer does not expect.
 */
export const CODEX_CALLBACK_TOOL_REGISTRATION_UNAVAILABLE_DETAIL: string =
  "ThreadStartParams.dynamicTools is experimental-generation-only at the pin and this driver negotiates experimentalApi: false, so no provider-side callback-tool registration is reachable";

/** One inbound ask, as the daemon-side responder sees it. */
export interface CodexInboundServerRequest {
  /** The JSON-RPC method, verbatim and untrusted; a key and a label only. */
  readonly method: string;
  readonly askKind: "callback-tool" | "approval";
  /** The raw `params`, untrusted; the responder parses what it needs. */
  readonly params: unknown;
}

/**
 * The daemon-side answer to one ask. `payload` is read only by arms whose provider response
 * carries daemon-composed content (a granted permission profile, an elicitation's answer).
 */
export type CodexServerRequestDecision =
  | { readonly decision: "allow"; readonly payload?: Record<string, unknown> | undefined }
  | { readonly decision: "refuse"; readonly reason: string };

/**
 * The port the daemon binds to answer routed asks: the callback-tool host for `item/tool/call`,
 * the approval evaluation seam otherwise. With no responder the driver fails closed. It also
 * projects `approval.requested` and `question.asked`, which need identity the transport lacks.
 */
export interface CodexServerRequestResponder {
  answer(request: CodexInboundServerRequest): Promise<CodexServerRequestDecision>;
}

/**
 * One routed ask with the identity needed to adjudicate and project it. `runId` is `null`, never
 * invented, when the ask cannot be attributed to a run (asked outside a run, or its turn has no
 * live route while two runs are live). A callback-tool ask is never unattributed: it is refused.
 */
export interface CodexSessionServerRequest extends CodexInboundServerRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId | null;
  /**
   * The normalized choice set this ask published, if readable; absent means none is carried. An
   * over-large or unreadable set is dropped and recorded; `params` still holds the original. See
   * {@link readCodexAskOptionSet}.
   */
  readonly options?: readonly ProviderAskOption[] | undefined;
}

/** The session-scoped responder the daemon binds on `CodexLifecycleOptions`. */
export interface CodexSessionServerRequestResponder {
  answer(request: CodexSessionServerRequest): Promise<CodexServerRequestDecision>;
}

/** The `DynamicToolCallResponse.contentItems` array, or an empty one. */
function readContentItems(
  payload: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] {
  const contentItems = payload?.["contentItems"];
  return Array.isArray(contentItems) ? contentItems : [];
}

/** The `GrantedPermissionProfile`, or an empty grant. */
function readGrantedPermissionProfile(
  payload: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const permissions = payload?.["permissions"];
  return typeof permissions === "object" && permissions !== null
    ? (permissions as Record<string, unknown>)
    : {};
}

/**
 * A routed ask's `turnId`. An over-long id is never resolved (a truncated prefix could match a
 * shorter live turn) but is recorded as a marked truncation, since `null` would read as an ask
 * that named no turn.
 */
export interface CodexRoutedAskTurnIdReading {
  /** Usable for a route lookup: the id exactly as sent, or `null`. */
  readonly resolvableTurnId: string | null;
  /** The same field rendered for a record: bounded, or `null` if none was sent. */
  readonly recordedTurnId: string | null;
  readonly recordedTurnIdTruncated: boolean;
}

const NO_ROUTED_ASK_TURN_ID: CodexRoutedAskTurnIdReading = Object.freeze({
  resolvableTurnId: null,
  recordedTurnId: null,
  recordedTurnIdTruncated: false,
});

/**
 * Reads the `turnId` a routed ask names, bounded here because it is untrusted text that reaches a
 * refusal reason and a diagnostic buffer. At the pin the legacy approvals have no `turnId` and
 * elicitation's is nullable, so the caller's disposition varies by ask kind.
 */
export function readRoutedAskTurnId(params: unknown): CodexRoutedAskTurnIdReading {
  if (typeof params !== "object" || params === null) {
    return NO_ROUTED_ASK_TURN_ID;
  }
  const namedTurnId = (params as Record<string, unknown>)["turnId"];
  if (typeof namedTurnId !== "string" || namedTurnId.length === 0) {
    return NO_ROUTED_ASK_TURN_ID;
  }
  if (namedTurnId.length <= CODEX_ROUTED_ASK_TURN_ID_MAX_LEN) {
    return {
      resolvableTurnId: namedTurnId,
      recordedTurnId: namedTurnId,
      recordedTurnIdTruncated: false,
    };
  }
  // Cut on a code point boundary: a lone surrogate does not round-trip through a JSON log sink.
  const boundedPrefix = namedTurnId.slice(0, CODEX_ROUTED_ASK_TURN_ID_MAX_LEN);
  const lastUnit = boundedPrefix.charCodeAt(boundedPrefix.length - 1);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return {
    resolvableTurnId: null,
    recordedTurnId: splitsSurrogatePair ? boundedPrefix.slice(0, -1) : boundedPrefix,
    recordedTurnIdTruncated: true,
  };
}

/**
 * The refusal text for one unattributable routed ask, composed from the bounded reading so a
 * provider turn id cannot size the string the provider and the log read back.
 */
export function composeRoutedAskRefusalReason(
  method: string,
  turnIdReading: CodexRoutedAskTurnIdReading,
): string {
  if (turnIdReading.recordedTurnId === null) {
    return `The provider's "${method}" request named no turn, and this method's params require one, so the daemon cannot say which run raised it; refusing rather than attributing it to a run that did not.`;
  }
  if (turnIdReading.resolvableTurnId === null) {
    return `The provider's "${method}" request named a turn id past the length this daemon reads, so it cannot be resolved to a run; refusing rather than matching a truncated prefix against a live turn.`;
  }
  return `The provider's "${method}" request named turn "${turnIdReading.resolvableTurnId}", which this daemon holds no live route for; refusing rather than attributing it to a run that did not raise it.`;
}

/**
 * How one routed ask was attributed to a run: by its named turn, by fallback to the session's sole
 * active run when it named no usable turn, or refused when its turn cannot be resolved.
 */
export type CodexRoutedAskAttribution =
  | { readonly outcome: "attributed"; readonly runId: RunId }
  | { readonly outcome: "unattributed"; readonly runId: RunId | null }
  | { readonly outcome: "refused"; readonly reason: string };

/** JSON-RPC "method not found" — the fail-closed answer to an unhandled server request. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The `thread/realtime/*` notifications opted out at negotiation (exact names, `codex-cli
 * 0.150.1`): V1 has no realtime surface, so each would be an unmapped-kind diagnostic per audio
 * delta. Re-derive when the pin moves; never widen it to quiet a diagnostic.
 */
export const CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  // The older `itemAdded` and `transcript/*` names still publish beside the newer `item/*` ones.
  "thread/realtime/itemAdded",
  "thread/realtime/sdp",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed",
]);
