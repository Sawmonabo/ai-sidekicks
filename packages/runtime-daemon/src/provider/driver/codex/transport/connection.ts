/**
 * One JSON-RPC connection to a Codex service over its websocket: request correlation with
 * deadlines, routed server requests and the asks held for the person, notifications, and a close
 * that leaves no promise pending.
 */

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { DEFAULT_PROVIDER_VERSION_CLIENT_NAME } from "../../../spawned-version.js";
import {
  type CodexDiagnosticSink,
  type CodexScheduleTimeout,
  type CodexServerNotificationSink,
  type CodexTransportDiagnostic,
  reportDiagnosticFromDetachedFrame,
} from "./diagnostics.js";
import type {
  CodexServiceSocket,
  CodexServiceSocketConnector,
  CodexServiceSocketDialOptions,
} from "./socket.js";
import {
  CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON,
  CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS,
  CODEX_SERVER_REQUEST_METHODS,
  type CodexAskKind,
  type CodexRoutedServerRequestDescriptor,
  type CodexServerRequestAnswer,
  type CodexServerRequestResponder,
  type CodexServerRequestResult,
} from "../server-requests.js";
import {
  CodexProviderRequestError,
  CodexRequestTooLargeError,
  CodexRequestTimeoutError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "../session/errors.js";
import { isPlainObject } from "../../../record-readers.js";
import { CODEX_OPT_OUT_NOTIFICATION_METHODS } from "../event-normalizer.js";

/** Deadline for an ordinary request; `turn/start` and the handshake carry their own. */
export const CODEX_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Schedules a callback with `setTimeout` and returns the function that cancels it. */
export const defaultScheduleTimeout: CodexScheduleTimeout = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancelDeadline: () => void;
}

/** A held ask the connection let go of: its request id, its kind and the thread it names. */
export interface CodexForgottenRequest {
  readonly requestId: string;
  readonly askKind: CodexAskKind;
  /** The conversation the ask names, or `null` when it names none. */
  readonly threadId: string | null;
}

/** An ask the responder held for the person, answered later by its request id. */
interface HeldServerRequest {
  readonly id: unknown;
  readonly method: string;
  readonly descriptor: CodexRoutedServerRequestDescriptor;
  readonly params: unknown;
}

/** What one connection reports to, and the deadlines it keeps. */
export interface CodexConnectionOptions {
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly scheduleTimeout?: CodexScheduleTimeout | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

/** Where one connection hands what the service sends it. */
export interface CodexConnectionHandlers {
  readonly onServerNotification: CodexServerNotificationSink;
  /** Answers routed server requests; without one, every routed ask is refused. */
  readonly serverRequestResponder: CodexServerRequestResponder | undefined;
  /** The socket closed without `close()`: the connection dropped or the service died. */
  readonly onDropped: (detail: string) => void;
  /**
   * The connection closed holding asks for the person; nothing can answer them on it now, and
   * Codex asks again on the connection that resumes their conversation.
   */
  readonly onHeldRequestsDropped: (dropped: readonly CodexForgottenRequest[]) => void;
}

/**
 * Opens one connection to the service on `socketPath` and runs the `initialize` handshake,
 * resolving with the connection and the handshake's reply, which carries the service's version.
 * A failure after the socket opened closes it before rethrowing.
 */
export async function openCodexConnection(request: {
  readonly connectSocket: CodexServiceSocketConnector;
  readonly socketPath: string;
  readonly dialOptions: CodexServiceSocketDialOptions;
  readonly options: CodexConnectionOptions;
  readonly handlers: CodexConnectionHandlers;
  readonly handshakeTimeoutMs: number;
}): Promise<{ readonly connection: CodexAppServerConnection; readonly initializeReply: unknown }> {
  const connection = new CodexAppServerConnection(request.options, request.handlers);
  const socket = await request.connectSocket(
    request.socketPath,
    {
      onMessage: (text) => {
        connection.receive(text);
      },
      onClose: (detail) => {
        connection.handleSocketClosed(detail);
      },
    },
    request.dialOptions,
  );
  connection.attach(socket);
  try {
    const initializeReply = await connection.request(
      "initialize",
      {
        clientInfo: {
          name: DEFAULT_PROVIDER_VERSION_CLIENT_NAME,
          title: "AI Sidekicks",
          version: "1",
        },
        // On because `thread/settings/update`, `thread/backgroundTerminals/*`, the `permissions`
        // thread member and `thread/turns/list` answer only then. One service has one opt-out
        // list, so it is every notification no conversation on it reads.
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: CODEX_OPT_OUT_NOTIFICATION_METHODS,
        },
      },
      request.handshakeTimeoutMs,
    );
    connection.notify("initialized", {});
    return { connection, initializeReply };
  } catch (cause) {
    connection.close();
    throw cause;
  }
}

/**
 * One websocket connection to a Codex service. Owns request correlation with deadlines, the
 * fail-closed answer to unhandled server requests, the asks held for the person, and teardown that
 * leaves no promise pending.
 */
export class CodexAppServerConnection {
  readonly #reportDiagnostic: CodexDiagnosticSink;
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #requestTimeoutMs: number;
  readonly #handlers: CodexConnectionHandlers;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #heldRequests = new Map<string, HeldServerRequest>();
  // Held asks whose answer is being sent, so a second answer cannot send another.
  readonly #answeringRequestIds = new Set<string>();
  #socket: CodexServiceSocket | null = null;
  #nextRequestId = 1;
  #closed = false;
  #closeReason: string | null = null;

  constructor(options: CodexConnectionOptions, handlers: CodexConnectionHandlers) {
    this.#reportDiagnostic = options.reportDiagnostic;
    this.#scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? CODEX_DEFAULT_REQUEST_TIMEOUT_MS;
    this.#handlers = handlers;
  }

  /** Binds the open socket; called once, by {@link openCodexConnection}. */
  attach(socket: CodexServiceSocket): void {
    this.#socket = socket;
  }

  /**
   * Sends a request and resolves with its `result`. Rejects with `CodexProviderRequestError` when
   * the provider answered with an error, with `CodexRequestTooLargeError`, sending nothing, when
   * the request is past the largest message the service said it takes, and with any other error
   * when the request may or may not have reached the provider.
   */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.#assertWritable(method);
    const requestId = this.#nextRequestId;
    // Encoding precedes the send, so a failure here put nothing on the wire.
    const text = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params });
    const oversized = this.#oversizedRequest(method, text);
    if (oversized !== undefined) {
      throw oversized;
    }
    this.#nextRequestId += 1;
    const armed = this.#armPendingResponse(String(requestId), method, timeoutMs);
    try {
      await this.#send(text);
    } catch (cause) {
      this.#cancelPendingResponse(String(requestId));
      throw cause;
    }
    return await armed;
  }

  /** Fire-and-forget notification. Failures surface through the diagnostic sink. */
  notify(method: string, params: unknown): void {
    this.#assertWritable(method);
    const text = JSON.stringify({ jsonrpc: "2.0", method, params });
    const oversized = this.#oversizedRequest(method, text);
    if (oversized !== undefined) {
      this.#reportQuietly({
        kind: "notification-write-failed",
        method,
        detail: normalizeProviderFailureDetail(oversized),
      });
      return;
    }
    void this.#send(text).catch((cause: unknown) => {
      // Reported, not thrown: the caller is mid-handshake and the next request's failure is the
      // actionable signal.
      this.#reportQuietly({
        kind: "notification-write-failed",
        method,
        detail: normalizeProviderFailureDetail(cause),
      });
    });
  }

  /**
   * Answers an ask the responder held, with the person's answer in the method's own shape. Throws
   * `CodexTransportError` when this connection holds no ask under `requestId`.
   */
  async answerHeldRequest(requestId: string, answer: CodexServerRequestAnswer): Promise<void> {
    const held = this.#heldRequests.get(requestId);
    if (held === undefined || this.#answeringRequestIds.has(requestId)) {
      throw new CodexTransportError(`No Codex request "${requestId}" is waiting for an answer.`, {
        requestId,
      });
    }
    // Composed first: an answer that does not fit the ask leaves it held for a right one.
    const result = composeAnswerResult(held, answer);
    this.#answeringRequestIds.add(requestId);
    try {
      await this.#sendAnswer(held.id, held.method, held.descriptor, result);
      // Let go only once sent: an answer that failed to send leaves the ask held for another.
      this.#heldRequests.delete(requestId);
    } finally {
      this.#answeringRequestIds.delete(requestId);
    }
  }

  /** Whether this connection holds an ask under `requestId` for the person. */
  holdsRequest(requestId: string): boolean {
    return this.#heldRequests.has(requestId);
  }

  /**
   * Lets go of a held ask Codex settled itself, so no answer is sent for it later. Answers the
   * kind of ask it was, or `undefined` when none was held under `requestId`.
   */
  forgetHeldRequest(requestId: string): CodexAskKind | undefined {
    const held = this.#heldRequests.get(requestId);
    this.#heldRequests.delete(requestId);
    this.#answeringRequestIds.delete(requestId);
    return held?.descriptor.classifyAsk(held.params);
  }

  /**
   * Lets go of every held ask a turn that ended made, since nothing can answer it now. Answers
   * each one's request id and kind.
   */
  forgetHeldRequestsOfTurn(threadId: string, turnId: string): CodexForgottenRequest[] {
    const forgotten: CodexForgottenRequest[] = [];
    for (const [requestId, held] of this.#heldRequests) {
      const params = isPlainObject(held.params) ? held.params : {};
      if (params["threadId"] === threadId && params["turnId"] === turnId) {
        this.#heldRequests.delete(requestId);
        forgotten.push({ requestId, askKind: held.descriptor.classifyAsk(held.params), threadId });
      }
    }
    return forgotten;
  }

  /** Closes the socket and rejects every request in flight. Idempotent. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#markClosed("closed");
    this.#socket?.close();
  }

  /** Handles one message from the socket. */
  receive(text: string): void {
    if (this.#closed) {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#reportQuietly({
        kind: "unparsable-message",
        reason: "not-json",
        characterCount: text.length,
      });
      return;
    }
    if (!isPlainObject(frame)) {
      this.#reportQuietly({
        kind: "unparsable-message",
        reason: "not-an-object",
        characterCount: text.length,
      });
      return;
    }
    const method = frame["method"];
    if (typeof method === "string") {
      this.#handleInboundMethod(method, frame);
      return;
    }
    this.#handleInboundResponse(frame, text);
  }

  /** Handles the socket closing; a close this connection did not ask for is a drop. */
  handleSocketClosed(detail: string): void {
    if (this.#closed) {
      return;
    }
    this.#markClosed(detail);
    this.#handlers.onDropped(detail);
  }

  #markClosed(reason: string): void {
    this.#closed = true;
    this.#closeReason = reason;
    const closedError = new CodexTransportError("The Codex service connection was closed.", {
      reason,
    });
    for (const pending of this.#pending.values()) {
      pending.cancelDeadline();
      pending.reject(closedError);
    }
    this.#pending.clear();
    // A held ask is replayed to the connection that next resumes its conversation, under a new
    // id, so the cards of these are withdrawn.
    const dropped = [...this.#heldRequests].map(([requestId, held]) =>
      readDroppedRequest(requestId, held),
    );
    this.#heldRequests.clear();
    this.#answeringRequestIds.clear();
    if (dropped.length > 0) {
      this.#handlers.onHeldRequestsDropped(dropped);
    }
  }

  #assertWritable(method: string): void {
    if (this.#closed || this.#socket === null) {
      throw new CodexTransportError(
        `Cannot send "${method}": the Codex service connection is closed.`,
        { method, reason: this.#closeReason ?? "not open" },
      );
    }
  }

  // The refusal for a message past the largest the service said it takes in one frame; none where
  // it named none. A larger message is never split into frames, since the service names no limit
  // for a split one.
  #oversizedRequest(method: string, text: string): CodexRequestTooLargeError | undefined {
    const limit = this.#socket?.sentMessageByteLimit;
    const encodedByteLength = Buffer.byteLength(text, "utf8");
    return limit !== undefined && encodedByteLength > limit
      ? new CodexRequestTooLargeError(method, encodedByteLength, limit)
      : undefined;
  }

  #send(text: string): Promise<void> {
    const socket = this.#socket;
    if (socket === null) {
      return Promise.reject(new CodexTransportError("The Codex service connection is not open."));
    }
    return socket.send(text);
  }

  /** Reserves the response slot and deadline for one request id. Synchronous on purpose. */
  #armPendingResponse(
    key: string,
    method: string,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    const deadlineMs = timeoutMs ?? this.#requestTimeoutMs;
    const settled = new Promise<unknown>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#pending.delete(key);
        reject(
          new CodexRequestTimeoutError(
            `The Codex service did not answer "${method}" within ${deadlineMs}ms.`,
            { method, timeoutMs: String(deadlineMs) },
          ),
        );
      }, deadlineMs);
      this.#pending.set(key, { method, resolve, reject, cancelDeadline });
    });
    // A close while the caller is suspended on its send would reject an unhandled promise, which
    // kills the daemon under Node's default; this marks it handled without consuming it.
    settled.catch(() => undefined);
    return settled;
  }

  #cancelPendingResponse(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
  }

  #handleInboundMethod(method: string, message: Record<string, unknown>): void {
    const id = message["id"];
    if (id !== undefined && id !== null) {
      // Routed asks (callback tools, approvals, elicitations) go through the daemon's pipeline.
      const routed = CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.get(method);
      if (routed !== undefined) {
        void this.#answerRoutedServerRequest(id, method, routed, message["params"]);
        return;
      }
      // Every other request fails closed, censused or not (a newer build may speak a method this
      // driver never saw): an error answer cannot be mistaken for consent, and silence hangs it.
      this.#reportQuietly({
        kind: "unhandled-server-request",
        method,
        censused: CODEX_SERVER_REQUEST_METHODS.has(method),
      });
      void this.#send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: JsonRpcErrorCode.MethodNotFound,
            message: `The driver does not handle "${method}".`,
          },
        }),
      ).catch((cause: unknown) => {
        this.#reportAnswerWriteFailure(method, cause);
      });
      return;
    }
    // Contained: a throwing consumer must not take the frames behind this one down with it.
    try {
      this.#handlers.onServerNotification(method, message["params"]);
    } catch (cause) {
      this.#reportQuietly({
        kind: "notification-consumer-failed",
        method,
        detail: normalizeProviderFailureDetail(cause),
      });
    }
  }

  /**
   * Answers one routed server request through the daemon's responder, or holds it for the person.
   * Every other path answers, with the method's own refusal shape rather than `-32601`, which the
   * provider may treat as a protocol fault. Rejections are absorbed: nothing awaits it.
   */
  async #answerRoutedServerRequest(
    id: unknown,
    method: string,
    descriptor: CodexRoutedServerRequestDescriptor,
    params: unknown,
  ): Promise<void> {
    const requestId = typeof id === "string" ? id : JSON.stringify(id);
    const responder = this.#handlers.serverRequestResponder;
    let result: CodexServerRequestResult;
    if (responder === undefined) {
      this.#reportQuietly({ kind: "unrouted-server-request-refused", method });
      result = descriptor.composeRefusedResult(
        `The daemon has no responder registered for "${method}"; refusing rather than ` +
          `answering without adjudication.`,
      );
    } else {
      try {
        const decision = await responder.answer({
          requestId,
          method,
          askKind: descriptor.classifyAsk(params),
          params,
        });
        if (decision.decision === "held") {
          const held: HeldServerRequest = { id, method, descriptor, params };
          if (this.#closed) {
            // Closed while the ask was being handed on: its card is withdrawn like the others.
            this.#handlers.onHeldRequestsDropped([readDroppedRequest(requestId, held)]);
          } else {
            this.#heldRequests.set(requestId, held);
          }
          return;
        }
        result = composeAnswerResult({ descriptor, params }, decision);
      } catch (cause) {
        // A responder that throws has not decided; an undecided ask is refused, never allowed.
        const detail = normalizeProviderFailureDetail(cause);
        this.#reportQuietly({ kind: "server-request-responder-failed", method, detail });
        result = descriptor.composeRefusedResult(detail);
      }
    }
    await this.#sendAnswer(id, method, descriptor, result).catch((cause: unknown) => {
      // A failed answer leaves the provider waiting on the ask, so it is reported.
      this.#reportAnswerWriteFailure(method, cause);
    });
  }

  /**
   * Sends one answer within the largest message the service said it takes, measured on the
   * encoded bytes, substituting a refusal with {@link CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON} for
   * an oversized one. A service that named no limit takes every answer.
   */
  async #sendAnswer(
    id: unknown,
    method: string,
    descriptor: CodexRoutedServerRequestDescriptor,
    result: CodexServerRequestResult,
  ): Promise<void> {
    const limit = this.#socket?.sentMessageByteLimit;
    const composed = JSON.stringify({ jsonrpc: "2.0", id, result });
    const composedBytes = Buffer.byteLength(composed, "utf8");
    if (limit === undefined || composedBytes <= limit) {
      await this.#send(composed);
      return;
    }
    this.#reportQuietly({
      kind: "server-request-answer-oversized",
      method,
      encodedByteLength: composedBytes,
      limit,
    });
    const refusal = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: descriptor.composeRefusedResult(CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON),
    });
    const refusalBytes = Buffer.byteLength(refusal, "utf8");
    if (refusalBytes <= limit) {
      await this.#send(refusal);
      return;
    }
    // Reachable only when the provider's request `id` is itself past the limit.
    this.#reportQuietly({
      kind: "server-request-answer-oversized",
      method,
      encodedByteLength: refusalBytes,
      limit,
    });
  }

  #handleInboundResponse(message: Record<string, unknown>, text: string): void {
    const id = message["id"];
    if (typeof id !== "number" && typeof id !== "string") {
      this.#reportQuietly({
        kind: "unparsable-message",
        reason: "response-without-id",
        characterCount: text.length,
      });
      return;
    }
    const key = String(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#reportQuietly({ kind: "unknown-response-id", responseId: key });
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
    const error = message["error"];
    if (error !== undefined && error !== null) {
      const errorRecord = isPlainObject(error) ? error : {};
      const rawCode = errorRecord["code"];
      const rawMessage = errorRecord["message"];
      pending.reject(
        new CodexProviderRequestError(
          pending.method,
          typeof rawCode === "number" ? rawCode : 0,
          typeof rawMessage === "string" ? rawMessage : "",
        ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  #reportQuietly(diagnostic: CodexTransportDiagnostic): void {
    reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, diagnostic);
  }

  #reportAnswerWriteFailure(method: string, cause: unknown): void {
    this.#reportQuietly({
      kind: "server-request-answer-write-failed",
      method,
      detail: normalizeProviderFailureDetail(cause),
    });
  }
}

/** A held ask as the connection lets go of it, with the conversation it names. */
function readDroppedRequest(requestId: string, held: HeldServerRequest): CodexForgottenRequest {
  const params = isPlainObject(held.params) ? held.params : {};
  // A legacy approval names its thread as its conversation.
  const threadId = params["threadId"] ?? params["conversationId"];
  return {
    requestId,
    askKind: held.descriptor.classifyAsk(held.params),
    threadId: typeof threadId === "string" && threadId.length > 0 ? threadId : null,
  };
}

/** The provider result one answer composes, in the asking method's own shape. */
function composeAnswerResult(
  held: Pick<HeldServerRequest, "descriptor" | "params">,
  answer: CodexServerRequestAnswer,
): CodexServerRequestResult {
  switch (answer.decision) {
    case "allow":
      return held.descriptor.composeAllowedResult(answer.payload, held.params);
    case "refuse":
      return held.descriptor.composeRefusedResult(answer.reason);
    case "answered": {
      // Answers sent for an approval would approve it, so only a question takes them.
      const composeAnswered = held.descriptor.composeAnsweredResult;
      const isQuestion = held.descriptor.classifyAsk(held.params) === "question";
      if (composeAnswered === undefined || !isQuestion) {
        throw new TypeError("Only a question is answered with answers.");
      }
      return composeAnswered(answer.answers, held.params);
    }
  }
}
