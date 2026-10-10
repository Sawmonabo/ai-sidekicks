/**
 * The requests the Codex app server sends to the client: which methods are routed to a person,
 * the descriptors that read them, and the decisions and responders that answer them.
 */

import type { QuestionAnswer } from "@ai-sidekicks/contracts/question";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { cutToCodeUnits } from "../../../text-cut.js";
import { isPlainObject } from "../../record-readers.js";
import type { ProviderAskOption } from "./ask-option-sets.js";
import { composeCodexElicitationContent } from "./delivery/elicitation-form.js";
import { composeCodexUserInputAnswers } from "./delivery/question-answers.js";
import { isCodexToolCallApprovalElicitation } from "./event-normalizer.js";

/**
 * Ceiling on one message the daemon takes from Codex, over its websocket or a hook, in UTF-8
 * bytes; Codex names no limit on what it sends. It stops a peer from growing one message until the
 * daemon dies.
 */
export const CODEX_MAX_RECEIVED_MESSAGE_BYTES: number = 32 * 1024 * 1024;

/**
 * The refusal reason substituted for an answer larger than the service said it takes, past which
 * it would close the socket: a constant, so it fits. The answer is refused, never truncated (a
 * truncated tool output reads as complete), and the loss is recorded on both diagnostic sinks.
 */
export const CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON: string =
  "The daemon composed an answer larger than this transport will send; refusing rather than " +
  "delivering a truncated result.";

/**
 * Bound on a provider `turnId` before it enters a refusal reason or diagnostic; matches
 * `DRIVER_TOOL_CALL_ID_MAX_LEN`, the same kind of opaque handle.
 */
const CODEX_ROUTED_ASK_TURN_ID_MAX_LEN = 256;

/**
 * The ten server-initiated request methods of the protocol (`ServerRequest` union at
 * `codex-cli 0.161.0`). An observability annotation, not a routing filter: routing is keyed on the
 * descriptors below, and any other method gets `-32601`.
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

// Server-request routing: a daemon tool's call goes to the callback-tool host; an approval and a
// question go to the run engine and then to the approvals or the questions card, which answer
// later through `respondToRequest`. Unrouted, so `-32601`: `attestation/generate` (declined at
// negotiation) and `account/chatgptAuthTokens/refresh` (credential brokering this driver does not
// do). Fail-closed: a routed method with no responder, a refusing one or a throwing one answers
// with the method's own refusal shape, never `-32601` (a protocol error where a decision was
// asked) and never silence (which hangs the turn).

/** Who answers a routed ask: the callback-tool host, the approvals, or the questions card. */
export type CodexAskKind = "callback-tool" | "approval" | "question";

/** The provider result for one answered ask, composed by its own descriptor. */
export type CodexServerRequestResult = Record<string, unknown>;

/** One routed server-request method and the two answers it can carry. */
export interface CodexRoutedServerRequestDescriptor {
  /** Which host answers one ask, read from its untrusted `params`. */
  readonly classifyAsk: (params: unknown) => CodexAskKind;
  /**
   * The allowed answer. `payload` carries data the daemon supplies (a granted permission profile,
   * an elicitation's content, a question's answers) and is merged, not substituted for the
   * decision member; `params` are the ask's own, untrusted.
   */
  readonly composeAllowedResult: (
    payload: Readonly<Record<string, unknown>> | undefined,
    params: unknown,
  ) => CodexServerRequestResult;
  /** The refusal answer. Never carries data: a refusal grants nothing. */
  readonly composeRefusedResult: (reason: string) => CodexServerRequestResult;
  /**
   * A question's answer, from the questions card's answers, one per question in order; absent on
   * a method that never asks one.
   */
  readonly composeAnsweredResult?: (
    answers: readonly QuestionAnswer[],
    params: unknown,
  ) => CodexServerRequestResult;
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
      classifyAsk: () => "callback-tool",
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
      classifyAsk: () => "approval",
      composeAllowedResult: () => ({ decision: "accept" }),
      composeRefusedResult: () => ({ decision: "decline" }),
    },
  ],
  [
    "item/fileChange/requestApproval",
    {
      classifyAsk: () => "approval",
      composeAllowedResult: () => ({ decision: "accept" }),
      composeRefusedResult: () => ({ decision: "decline" }),
    },
  ],
  [
    "item/permissions/requestApproval",
    {
      classifyAsk: () => "approval",
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
      classifyAsk: () => "approval",
      composeAllowedResult: () => ({ decision: "approved" }),
      composeRefusedResult: (reason) => ({ decision: { denied: { rejection: reason } } }),
    },
  ],
  [
    "applyPatchApproval",
    {
      classifyAsk: () => "approval",
      composeAllowedResult: () => ({ decision: "approved" }),
      composeRefusedResult: (reason) => ({ decision: { denied: { rejection: reason } } }),
    },
  ],
  [
    "item/tool/requestUserInput",
    {
      classifyAsk: () => "question",
      // A question is answered with its answers, never a bare allow.
      composeAllowedResult: () => {
        throw new TypeError("A Codex question is answered with its answers, not an allow.");
      },
      // A question has no decline; an empty answer set is the refusal Codex reads.
      composeRefusedResult: () => ({ answers: {} }),
      composeAnsweredResult: (answers, params) => ({
        answers: composeCodexUserInputAnswers(params, answers),
      }),
    },
  ],
  [
    "mcpServer/elicitation/request",
    {
      // Codex's own approval of a tool-server call is the approval card; any other is a question.
      classifyAsk: (params) =>
        isCodexToolCallApprovalElicitation(params) ? "approval" : "question",
      composeAllowedResult: (payload) =>
        payload === undefined ? { action: "accept" } : { action: "accept", content: payload },
      composeRefusedResult: () => ({ action: "decline" }),
      // A question's answers fill the form's fields.
      composeAnsweredResult: (answers, params) => ({
        action: "accept",
        content: composeCodexElicitationContent(params, answers),
      }),
    },
  ],
]);

/** One inbound ask, as the daemon-side responder sees it. */
export interface CodexInboundServerRequest {
  /**
   * The provider's own request id, as text; `respondToRequest` answers a held ask under it. Unique
   * on one service connection.
   */
  readonly requestId: string;
  /** The JSON-RPC method, verbatim and untrusted; a key and a label only. */
  readonly method: string;
  readonly askKind: CodexAskKind;
  /** The raw `params`, untrusted; the responder parses what it needs. */
  readonly params: unknown;
}

/**
 * The daemon-side answer to one ask. `payload` is read only by arms whose provider response
 * carries daemon-composed content (a granted permission profile, a tool-server approval's
 * content); a question is `answered` with the questions card's answers, one per question.
 */
export type CodexServerRequestAnswer =
  | { readonly decision: "allow"; readonly payload?: Record<string, unknown> | undefined }
  | { readonly decision: "refuse"; readonly reason: string }
  | { readonly decision: "answered"; readonly answers: readonly QuestionAnswer[] };

/**
 * Reads the person's answer to a held ask as it arrives: a question's `{answers}`, one per
 * question in order, or the approval pipeline's `allow` (with an optional object `payload`) or
 * `refuse` with a reason. Throws `TypeError` for anything else.
 */
export function readCodexServerRequestAnswer(response: unknown): CodexServerRequestAnswer {
  if (isPlainObject(response)) {
    const answers = response["answers"];
    if (Array.isArray(answers)) {
      // The questions service validated each answer against the questions contract.
      return { decision: "answered", answers: answers as readonly QuestionAnswer[] };
    }
    const payload = response["payload"];
    if (response["decision"] === "allow" && (payload === undefined || isPlainObject(payload))) {
      return payload === undefined ? { decision: "allow" } : { decision: "allow", payload };
    }
    const reason = response["reason"];
    if (response["decision"] === "refuse" && typeof reason === "string") {
      return { decision: "refuse", reason };
    }
  }
  throw new TypeError(
    "A Codex ask is answered with its answers, an allow, or a refusal with its reason.",
  );
}

/**
 * What the responder did with one ask: answered it now, or `held` it for the person, who answers
 * later through `respondToRequest` with a {@link CodexServerRequestAnswer}. A held ask stays
 * pending at the provider until then.
 */
export type CodexServerRequestDecision = CodexServerRequestAnswer | { readonly decision: "held" };

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
  return {
    resolvableTurnId: null,
    recordedTurnId: cutToCodeUnits(namedTurnId, CODEX_ROUTED_ASK_TURN_ID_MAX_LEN),
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
    return (
      `The provider's "${method}" request named no turn, and this method's params require one, ` +
      `so the daemon cannot say which run raised it; refusing rather than attributing it to a ` +
      `run that did not.`
    );
  }
  if (turnIdReading.resolvableTurnId === null) {
    return (
      `The provider's "${method}" request named a turn id past the length this daemon reads, ` +
      `so it cannot be resolved to a run; refusing rather than matching a truncated prefix ` +
      `against a live turn.`
    );
  }
  return (
    `The provider's "${method}" request named turn "${turnIdReading.resolvableTurnId}", which ` +
    `this daemon holds no live route for; refusing rather than attributing it to a run that ` +
    `did not raise it.`
  );
}

/** The run an ask belongs to, and the binding its permission ask is delivered on. */
export interface CodexAskOwner {
  readonly runId: RunId;
  readonly bindingId: string;
}

/**
 * How one routed ask was attributed to a run: by its helper's child run or its named turn, by
 * fallback to the session's sole active run when it named no usable turn, or refused when its turn
 * cannot be resolved.
 */
export type CodexRoutedAskAttribution =
  | { readonly outcome: "attributed"; readonly owner: CodexAskOwner }
  | { readonly outcome: "unattributed"; readonly owner: CodexAskOwner | null }
  | { readonly outcome: "refused"; readonly reason: string };
