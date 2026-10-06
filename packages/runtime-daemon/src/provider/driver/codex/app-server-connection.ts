/**
 * One JSON-RPC connection to the Codex app server: framing, request timeouts, server requests and
 * notifications, and the process or socket underneath.
 */

import { CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import { CODEX_DRIVER_NAME } from "./capabilities.js";
import {
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type SpawnEnvPair,
} from "../../spawn-env.js";
import {
  type CodexDiagnosticSink,
  type CodexPtySessionSubscriber,
  type CodexScheduleTimeout,
  type CodexServerNotificationSink,
  type CodexTransportDiagnostic,
  reportDiagnosticFromDetachedFrame,
} from "./transport/diagnostics.js";
import {
  CODEX_APP_SERVER_READY_SENTINEL,
  CODEX_APP_SERVER_SHELL_ARGV0,
  CODEX_APP_SERVER_SHELL_PRELUDE,
  CODEX_DEFAULT_EXECUTABLE_PATH,
  type CodexTransportSelection,
  composeCodexTransportArgv,
} from "./transport/selection.js";
import {
  CODEX_MAX_LINE_LENGTH,
  CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON,
  CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS,
  type CodexRoutedServerRequestDescriptor,
  type CodexServerRequestResponder,
  type CodexServerRequestResult,
} from "./server-requests.js";
import type { CodexSessionConfig } from "./session/config.js";
import {
  CodexLineTooLongError,
  CodexProviderRequestError,
  CodexRequestTimeoutError,
  CodexTransportError,
  normalizeProviderFailureDetail,
} from "./session/errors.js";
import { isPlainObject } from "../../record-readers.js";
import type { SpawnRequest } from "../../../pty/host/protocol.js";
import type { PtyHost } from "../../../pty/host/pty-host.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_PTY_ROWS = 24;

const DEFAULT_PTY_COLS = 120;

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

/** Construction inputs shared by the connection and the manager. */
export interface CodexConnectionOptions {
  readonly ptyHost: PtyHost;
  /** The base every spawn's environment is built from, captured at the daemon's start. */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  readonly subscribeToPtySession: CodexPtySessionSubscriber;
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly executablePath?: string | undefined;
  readonly scheduleTimeout?: CodexScheduleTimeout | undefined;
  readonly onServerNotification?: CodexServerNotificationSink | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly turnStartTimeoutMs?: number | undefined;
  readonly rows?: number | undefined;
  readonly cols?: number | undefined;
  /** How the daemon reaches this process. */
  readonly transportSelection?: CodexTransportSelection | undefined;
  /** Answers routed server requests; without one, every routed ask is refused. */
  readonly serverRequestResponder?: CodexServerRequestResponder | undefined;
}

/**
 * How far a failed request's bytes provably got: `unsent` (no byte reached the host), `refused`
 * (the provider answered with a JSON-RPC error), or `indeterminate` (the host took the bytes and
 * whether the provider acted on them is unknowable). Only the transport can tell, because the
 * error classes for "refused before the write" and "killed in flight" are near-identical.
 */
export type CodexRequestDelivery = "unsent" | "refused" | "indeterminate";

/** The outcome of one request, returned rather than thrown, with a failure's delivery. */
export type CodexRequestAttempt =
  | { readonly settled: "answered"; readonly result: unknown }
  | {
      readonly settled: "failed";
      readonly delivery: CodexRequestDelivery;
      readonly cause: unknown;
    };

/** A frame resolved to its destination and its bytes, one step short of the wire. */
interface CodexEncodedFrame {
  readonly ptySessionId: string;
  readonly bytes: Uint8Array;
}

/**
 * One `codex app-server` process reached over one `PtyHost` session. Owns newline-delimited JSON
 * framing, request correlation with deadlines, the fail-closed answer to unhandled server
 * requests, and teardown that leaves no promise pending.
 */
export class CodexAppServerConnection {
  readonly #ptyHost: PtyHost;
  readonly #subscribeToPtySession: CodexPtySessionSubscriber;
  readonly #reportDiagnostic: CodexDiagnosticSink;
  readonly #providerBaseEnvironment: readonly SpawnEnvPair[];
  readonly #scheduleTimeout: CodexScheduleTimeout;
  readonly #onServerNotification: CodexServerNotificationSink | undefined;
  readonly #executablePath: string;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #rows: number;
  readonly #cols: number;

  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder = new TextDecoder("utf-8");
  readonly #encoder = new TextEncoder();

  #ptySessionId: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #readBuffer = "";
  #nextRequestId = 1;
  #sawReadySentinel = false;
  #onReady: (() => void) | null = null;
  #onReadyFailed: ((error: Error) => void) | null = null;
  #closed = false;
  #ptyClosed = false;
  #exitDescription: string | null = null;
  readonly #transportSelection: CodexTransportSelection;
  readonly #serverRequestResponder: CodexServerRequestResponder | undefined;

  constructor(options: CodexConnectionOptions) {
    this.#ptyHost = options.ptyHost;
    this.#subscribeToPtySession = options.subscribeToPtySession;
    this.#reportDiagnostic = options.reportDiagnostic;
    this.#providerBaseEnvironment = options.providerBaseEnvironment;
    this.#scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
    this.#onServerNotification = options.onServerNotification;
    this.#executablePath = options.executablePath ?? CODEX_DEFAULT_EXECUTABLE_PATH;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#rows = options.rows ?? DEFAULT_PTY_ROWS;
    this.#cols = options.cols ?? DEFAULT_PTY_COLS;
    this.#transportSelection = options.transportSelection ?? { transport: "stdio" };
    this.#serverRequestResponder = options.serverRequestResponder;
  }

  /** The transport this connection reaches its provider process over. */
  get transportSelection(): CodexTransportSelection {
    return this.#transportSelection;
  }

  /** The pty session id, once spawned. Exposed for teardown bookkeeping and tests. */
  get ptySessionId(): string | null {
    return this.#ptySessionId;
  }

  /** True once `close()` ran or the child exited. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Spawns the process, waits for the prelude's ready sentinel, then performs the `initialize`
   * handshake. A failure after the spawn tears the process down before rethrowing.
   */
  async open(config: CodexSessionConfig): Promise<void> {
    const spawnRequest: SpawnRequest = {
      kind: "spawn_request",
      command: "/bin/sh",
      args: [
        "-c",
        CODEX_APP_SERVER_SHELL_PRELUDE,
        CODEX_APP_SERVER_SHELL_ARGV0,
        ...composeCodexTransportArgv(this.#transportSelection),
      ],
      // The captured base with the session's pairs set over it, minus what the credential policy
      // denies, plus the binary path the prelude reads (mandated, so the deny strip cannot remove
      // it); `process.env` is never consulted. Name matching follows the running platform, not the
      // policy: whether `path` and `PATH` are one variable is an OS fact, and a spawn with no
      // declared posture carries no policy.
      env: buildProviderSpawnEnv({
        driverName: CODEX_DRIVER_NAME,
        baseEnv: this.#providerBaseEnvironment,
        environmentRows: config.env,
        hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
        credentialEnvPolicy: config.credentialEnvPolicy,
        additionalMandatedPairs: [[CODEX_APP_SERVER_BIN_ENVIRONMENT_NAME, this.#executablePath]],
      }).map((pair) => [pair[0], pair[1]] as [string, string]),
      cwd: config.cwd,
      rows: this.#rows,
      cols: this.#cols,
    };

    const response = await this.#ptyHost.spawn(spawnRequest);
    if (response.error !== undefined && response.error.length > 0) {
      throw new CodexTransportError("Failed to spawn the Codex app-server process.", {
        ptyError: response.error,
      });
    }
    if (response.session_id.length === 0) {
      throw new CodexTransportError(
        "PtyHost returned an empty session id for the Codex app-server spawn.",
      );
    }
    this.#ptySessionId = response.session_id;

    try {
      // Inside the guard: a throwing subscriber outside it would leave the child running.
      this.#unsubscribe = this.#subscribeToPtySession(response.session_id, {
        onData: (chunk) => {
          this.#ingest(chunk);
        },
        onExit: (exitCode, signalCode) => {
          this.#handleExit(exitCode, signalCode ?? null);
        },
      });
      await this.#awaitReadySentinel();
      await this.request(
        "initialize",
        {
          clientInfo: { name: "codex-driver", title: "AI Sidekicks", version: "1" },
          capabilities: {
            // On because `thread/settings/update`, `thread/backgroundTerminals/list` and
            // `terminate`, `collaborationMode/list` and `thread/memoryMode/set` answer only then.
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: CODEX_SUPPRESSED_REALTIME_NOTIFICATION_METHODS,
          },
        },
        this.#startupTimeoutMs,
      );
      this.notify("initialized", {});
    } catch (cause) {
      // A disposer fault in `close()` is reported, so it cannot replace the startup failure.
      await this.close().catch((closeFault: unknown) => {
        this.#reportDisposeFailure(closeFault);
      });
      throw cause;
    }
  }

  /** Sends a request and resolves with its `result`, or rejects with a typed error. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.#assertWritable(method);
    const armed = this.#armPendingResponse(method, timeoutMs);
    try {
      await this.#writeFrame({ jsonrpc: "2.0", id: armed.requestId, method, params });
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      throw cause;
    }
    return armed.settled;
  }

  /**
   * Sends a request and reports the outcome, classifying a failure by delivery. Everything past
   * the write is `indeterminate` unless the provider answered with an error.
   */
  async attemptRequest(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<CodexRequestAttempt> {
    try {
      this.#assertWritable(method);
    } catch (cause) {
      return { settled: "failed", delivery: "unsent", cause };
    }
    const armed = this.#armPendingResponse(method, timeoutMs);
    let encodedFrame: CodexEncodedFrame;
    try {
      // Encoding precedes the first byte, so a failure here put nothing on the wire.
      encodedFrame = this.#encodeFrame({ jsonrpc: "2.0", id: armed.requestId, method, params });
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      return { settled: "failed", delivery: "unsent", cause };
    }
    try {
      await this.#writeEncodedFrame(encodedFrame.ptySessionId, encodedFrame.bytes);
    } catch (cause) {
      this.#cancelPendingResponse(armed.key);
      // The host promises no delivery either way, and a partial line can read as a whole request.
      return { settled: "failed", delivery: "indeterminate", cause };
    }
    try {
      return { settled: "answered", result: await armed.settled };
    } catch (cause) {
      return {
        settled: "failed",
        delivery: cause instanceof CodexProviderRequestError ? "refused" : "indeterminate",
        cause,
      };
    }
  }

  /** Reserves the response slot and deadline for one request id. Synchronous on purpose. */
  #armPendingResponse(
    method: string,
    timeoutMs: number | undefined,
  ): { readonly requestId: number; readonly key: string; readonly settled: Promise<unknown> } {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = String(requestId);
    const deadlineMs = timeoutMs ?? this.#requestTimeoutMs;

    const settled = new Promise<unknown>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#pending.delete(key);
        reject(
          new CodexRequestTimeoutError(
            `Codex app-server did not answer "${method}" within ${deadlineMs}ms.`,
            { method, timeoutMs: String(deadlineMs) },
          ),
        );
      }, deadlineMs);
      this.#pending.set(key, { method, resolve, reject, cancelDeadline });
    });
    // A child exit while the caller is suspended on its write would reject an unhandled promise,
    // which kills the daemon under Node's default; this marks it handled without consuming it.
    settled.catch(() => {
      /* the returned promise is the caller's channel */
    });
    return { requestId, key, settled };
  }

  /** Withdraws a reserved response slot whose request never got to be answered. */
  #cancelPendingResponse(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
  }

  /** Fire-and-forget notification. Failures surface through the diagnostic sink. */
  notify(method: string, params: unknown): void {
    this.#assertWritable(method);
    void this.#writeFrame({ jsonrpc: "2.0", method, params }).catch((cause: unknown) => {
      // Reported, not thrown: the caller is mid-handshake and the next request's failure is the
      // actionable signal.
      this.#reportDiagnosticQuietly({
        kind: "notification-write-failed",
        method,
        detail: normalizeProviderFailureDetail(cause),
      });
    });
  }

  /** Tears the connection down. Idempotent: a second call does not close the host session again. */
  async close(): Promise<void> {
    // Guarded on the PTY release, not `#closed`: an exited child has not released the host record.
    if (this.#ptyClosed) {
      return;
    }
    this.#ptyClosed = true;
    this.#closed = true;
    const closedError = new CodexTransportError("The Codex app-server connection was closed.", {
      reason: this.#exitDescription ?? "closed",
    });
    this.#rejectAllPending(closedError);
    this.#onReadyFailed?.(closedError);
    // The disposer can throw; the fault is held and rethrown after the release below, or the child
    // could keep running beside a replacement. Boxed because `undefined` is a throwable value.
    let disposeFault: { readonly cause: unknown } | null = null;
    if (this.#unsubscribe !== null) {
      const dispose = this.#unsubscribe;
      this.#unsubscribe = null;
      try {
        dispose();
      } catch (cause) {
        disposeFault = { cause };
      }
    }
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      try {
        await this.#ptyHost.close(ptySessionId);
      } catch (cause) {
        this.#reportTeardownStepFailure("pty-close", cause);
      }
    }
    if (disposeFault !== null) {
      // Rethrown so `close()`'s failure contract holds; the process is already gone by now.
      throw disposeFault.cause;
    }
  }

  /**
   * Kills the child, then closes, with no graceful phase; for an ambiguous outcome such as a
   * `turn/start` that may or may not have been accepted. `PtyHost.close` documents no signal.
   */
  async killAndClose(): Promise<void> {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null && !this.#ptyClosed) {
      try {
        await this.#ptyHost.kill(ptySessionId, "SIGKILL");
      } catch (cause) {
        this.#reportTeardownStepFailure("pty-kill", cause);
      }
    }
    await this.close();
  }

  #assertWritable(method: string): void {
    if (this.#closed) {
      throw new CodexTransportError(
        `Cannot send "${method}": the Codex app-server connection is closed.`,
        { method, reason: this.#exitDescription ?? "closed" },
      );
    }
  }

  // `async` so an encode failure is a rejection: `notify` handles it through `.catch()`.
  async #writeFrame(frame: Record<string, unknown>): Promise<void> {
    const encodedFrame = this.#encodeFrame(frame);
    await this.#writeEncodedFrame(encodedFrame.ptySessionId, encodedFrame.bytes);
  }

  /** Destination resolution and serialization; touches no host state, so a failure is unsent. */
  #encodeFrame(frame: Record<string, unknown>): CodexEncodedFrame {
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId === null) {
      throw new CodexTransportError("The Codex app-server connection is not open.");
    }
    return { ptySessionId, bytes: this.#encoder.encode(`${JSON.stringify(frame)}\n`) };
  }

  /**
   * The single write site; past it, delivery is unknowable. Not `async`, so the microtask hops
   * match awaiting `PtyHost.write` directly.
   */
  #writeEncodedFrame(ptySessionId: string, bytes: Uint8Array): Promise<void> {
    return this.#ptyHost.write(ptySessionId, bytes);
  }

  #awaitReadySentinel(): Promise<void> {
    if (this.#sawReadySentinel) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const cancelDeadline = this.#scheduleTimeout(() => {
        this.#clearReadyWait();
        reject(
          new CodexTransportError(
            `The Codex app-server prelude did not report readiness within ` +
              `${this.#startupTimeoutMs}ms.`,
            { timeoutMs: String(this.#startupTimeoutMs) },
          ),
        );
      }, this.#startupTimeoutMs);
      this.#onReady = () => {
        cancelDeadline();
        this.#clearReadyWait();
        resolve();
      };
      // Not a pending request, so exit and close must fail it explicitly, or a binary that dies
      // during startup (a missing executable exits 126) leaves `open()` unsettled forever.
      this.#onReadyFailed = (error) => {
        cancelDeadline();
        this.#clearReadyWait();
        reject(error);
      };
    });
  }

  #ingest(chunk: Uint8Array): void {
    // Data can arrive after teardown; appending it would re-grow the abandoned buffer.
    if (this.#ptyClosed) {
      return;
    }
    // `stream: true` so a multi-byte character split across chunks is not mangled.
    this.#readBuffer += this.#decoder.decode(chunk, { stream: true });
    let newlineIndex = this.#readBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      // Measured before the slice: an over-long line that terminates in the same chunk leaves a
      // short tail the post-loop check would miss.
      if (newlineIndex > CODEX_MAX_LINE_LENGTH) {
        this.#failFraming(newlineIndex);
        return;
      }
      const line = this.#readBuffer.slice(0, newlineIndex);
      this.#readBuffer = this.#readBuffer.slice(newlineIndex + 1);
      // Output post-processing is left on, so server lines arrive CRLF-terminated.
      this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      newlineIndex = this.#readBuffer.indexOf("\n");
    }
    // Only an unterminated tail grows without bound; many ordinary frames in aggregate are fine.
    if (this.#readBuffer.length > CODEX_MAX_LINE_LENGTH) {
      this.#failFraming(this.#readBuffer.length);
    }
  }

  /**
   * Abandons an over-long line and its connection. The tail is discarded unparsed, never
   * truncated: a prefix could parse as a valid but incomplete frame. In-flight callers and the
   * startup waiter fail with the typed error before the release, so they see why it died.
   */
  #failFraming(retainedLength: number): void {
    const error = new CodexLineTooLongError(retainedLength, CODEX_MAX_LINE_LENGTH);
    this.#readBuffer = "";
    this.#reportDiagnosticQuietly({
      kind: "line-too-long",
      retainedLength,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    this.#rejectAllPending(error);
    this.#onReadyFailed?.(error);
    // `PtyHost.close` does not signal the child, so `close()` alone could leave it running.
    // `SIGKILL`: no protocol is left for an orderly stop; the graceful path is `closeSession`.
    const ptySessionId = this.#ptySessionId;
    if (ptySessionId !== null) {
      void this.#ptyHost.kill(ptySessionId, "SIGKILL").catch((cause: unknown) => {
        this.#reportTeardownStepFailure("pty-kill", cause);
      });
    }
    void this.close().catch((cause: unknown) => {
      this.#reportDisposeFailure(cause);
    });
  }

  #handleLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    if (!this.#sawReadySentinel && line === CODEX_APP_SERVER_READY_SENTINEL) {
      this.#sawReadySentinel = true;
      this.#onReady?.();
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // Shell diagnostics, provider stderr or a truncated frame; a mis-set tty shows up here.
      this.#reportDiagnosticQuietly({ kind: "unparsable-line", line });
      return;
    }
    if (!isPlainObject(frame)) {
      this.#reportDiagnosticQuietly({ kind: "unparsable-line", line });
      return;
    }
    const message = frame;
    const method = message["method"];
    if (typeof method === "string") {
      this.#handleInboundMethod(method, message);
      return;
    }
    this.#handleInboundResponse(message, line);
  }

  #handleInboundMethod(method: string, message: Record<string, unknown>): void {
    const id = message["id"];
    const isRequest = id !== undefined && id !== null;
    if (isRequest) {
      if (this.#isEchoOfOurOwnRequest(id, method)) {
        // Our own frame echoed by a tty with ECHO on; answering it would corrupt correlation.
        this.#reportDiagnosticQuietly({ kind: "echoed-client-frame", method });
        return;
      }
      // Routed asks (callback tools, approvals, elicitations) go through the daemon's pipeline.
      const routed = CODEX_ROUTED_SERVER_REQUEST_DESCRIPTORS.get(method);
      if (routed !== undefined) {
        void this.#answerRoutedServerRequest(id, method, routed, message["params"]);
        return;
      }
      // Every other request fails closed, censused or not (a newer build may speak a method this
      // pin never saw): an error answer cannot be mistaken for consent, and silence hangs the turn.
      this.#reportDiagnosticQuietly({
        kind: "unhandled-server-request",
        method,
        censused: CODEX_SERVER_REQUEST_METHODS.has(method),
      });
      void this.#writeFrame({
        jsonrpc: "2.0",
        id,
        error: {
          code: JsonRpcErrorCode.MethodNotFound,
          message: `The driver does not handle "${method}" at this lifecycle stage.`,
        },
      }).catch((cause: unknown) => {
        this.#reportAnswerWriteFailure(method, cause);
      });
      return;
    }
    if (this.#onServerNotification !== undefined) {
      // Contained here too: a throwing consumer would unwind `#ingest` and drop the frames queued
      // behind this one in the same chunk.
      try {
        this.#onServerNotification(method, message["params"]);
      } catch (cause) {
        this.#reportDiagnosticQuietly({
          kind: "notification-consumer-failed",
          method,
          detail: normalizeProviderFailureDetail(cause),
        });
      }
      return;
    }
    this.#reportDiagnosticQuietly({ kind: "unconsumed-server-notification", method });
  }

  /**
   * Answers one routed server request through the daemon's responder. Every path answers, with
   * the method's own refusal shape rather than `-32601`, which the provider may treat as a
   * protocol fault. Rejections are absorbed here because the caller does not await it.
   */
  async #answerRoutedServerRequest(
    id: unknown,
    method: string,
    descriptor: CodexRoutedServerRequestDescriptor,
    params: unknown,
  ): Promise<void> {
    const responder = this.#serverRequestResponder;
    let result: CodexServerRequestResult;
    if (responder === undefined) {
      const reason =
        `The daemon has no responder registered for "${method}"; refusing rather than ` +
        `answering without adjudication.`;
      this.#reportDiagnosticQuietly({ kind: "unrouted-server-request-refused", method });
      result = descriptor.composeRefusedResult(reason);
    } else {
      try {
        const decision = await responder.answer({
          method,
          askKind: descriptor.askKind,
          params,
        });
        result =
          decision.decision === "allow"
            ? descriptor.composeAllowedResult(decision.payload)
            : descriptor.composeRefusedResult(decision.reason);
      } catch (cause) {
        // A responder that throws has not decided; an undecided ask is refused, never allowed.
        const detail = normalizeProviderFailureDetail(cause);
        this.#reportDiagnosticQuietly({
          kind: "server-request-responder-failed",
          method,
          detail,
        });
        result = descriptor.composeRefusedResult(detail);
      }
    }
    const encodedAnswer = this.#encodeBoundedAnswerFrame(id, method, descriptor, result);
    if (encodedAnswer === null) {
      // Both attempts are already reported.
      return;
    }
    await this.#writeEncodedFrame(encodedAnswer.ptySessionId, encodedAnswer.bytes).catch(
      (cause: unknown) => {
        // A rejected answer leaves the provider waiting on the ask forever, so it is reported.
        this.#reportAnswerWriteFailure(method, cause);
      },
    );
  }

  /**
   * Encodes one answer frame within the line-length bound, measured on the encoded bytes,
   * substituting a refusal with {@link CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON} for an oversized
   * one. Returns `null` when nothing is sendable; every failed attempt has been reported.
   */
  #encodeBoundedAnswerFrame(
    id: unknown,
    method: string,
    descriptor: CodexRoutedServerRequestDescriptor,
    result: CodexServerRequestResult,
  ): CodexEncodedFrame | null {
    const composedAnswer = this.#encodeAnswerFrameOrReport(id, method, result);
    if (composedAnswer === null) {
      return null;
    }
    if (composedAnswer.bytes.length <= CODEX_MAX_LINE_LENGTH) {
      return composedAnswer;
    }
    this.#reportDiagnosticQuietly({
      kind: "server-request-answer-oversized",
      method,
      encodedByteLength: composedAnswer.bytes.length,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    const substitutedRefusal = this.#encodeAnswerFrameOrReport(
      id,
      method,
      descriptor.composeRefusedResult(CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON),
    );
    if (substitutedRefusal === null) {
      return null;
    }
    if (substitutedRefusal.bytes.length <= CODEX_MAX_LINE_LENGTH) {
      return substitutedRefusal;
    }
    // Reachable only when the provider's request `id` is itself past the bound.
    this.#reportDiagnosticQuietly({
      kind: "server-request-answer-oversized",
      method,
      encodedByteLength: substitutedRefusal.bytes.length,
      limit: CODEX_MAX_LINE_LENGTH,
    });
    return null;
  }

  /** The frame encode with its throw recorded rather than raised. */
  #encodeAnswerFrameOrReport(
    id: unknown,
    method: string,
    result: CodexServerRequestResult,
  ): CodexEncodedFrame | null {
    try {
      return this.#encodeFrame({ jsonrpc: "2.0", id, result });
    } catch (cause) {
      // A closed connection or an unserializable `result` must not escape into the ingest loop.
      this.#reportAnswerWriteFailure(method, cause);
      return null;
    }
  }

  /**
   * True for an echo of our own pending request. Both id and method must match: the two
   * directions mint ids independently. The pending entry stays, since the real reply is owed.
   */
  #isEchoOfOurOwnRequest(id: unknown, method: string): boolean {
    if (typeof id !== "number" && typeof id !== "string") {
      return false;
    }
    return this.#pending.get(String(id))?.method === method;
  }

  #handleInboundResponse(message: Record<string, unknown>, line: string): void {
    const id = message["id"];
    if (typeof id !== "number" && typeof id !== "string") {
      this.#reportDiagnosticQuietly({ kind: "unparsable-line", line });
      return;
    }
    const key = String(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#reportDiagnosticQuietly({ kind: "unknown-response-id", responseId: key });
      return;
    }
    this.#pending.delete(key);
    pending.cancelDeadline();
    const error = message["error"];
    if (error !== undefined && error !== null) {
      const errorRecord = isPlainObject(error) ? error : {};
      const rawCode = errorRecord["code"];
      const rawMessage = errorRecord["message"];
      const providerErrorCode = typeof rawCode === "number" ? rawCode : 0;
      const providerMessage = typeof rawMessage === "string" ? rawMessage : "";
      pending.reject(
        new CodexProviderRequestError(pending.method, providerErrorCode, providerMessage),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  /**
   * Handles the child exiting, inside a `PtyHost` event callback: the diagnostic sink and the
   * disposer are contained so an exception cannot skip the cleanup.
   */
  #handleExit(exitCode: number, signalCode: number | null): void {
    this.#exitDescription = `exit ${exitCode}${signalCode === null ? "" : ` signal ${signalCode}`}`;
    this.#reportDiagnosticQuietly({ kind: "process-exited", exitCode, signalCode });
    // Closed before rejecting, so a retrying handler is refused: a write to an exited pty raises
    // an asynchronous EIO no caller can catch.
    this.#closed = true;
    // A disposer failure is reported, not rethrown (there is no caller).
    let disposeFault: { readonly cause: unknown } | null = null;
    if (this.#unsubscribe !== null) {
      const dispose = this.#unsubscribe;
      this.#unsubscribe = null;
      try {
        dispose();
      } catch (cause) {
        disposeFault = { cause };
      }
    }
    const exitError = new CodexTransportError("The Codex app-server process exited.", {
      reason: this.#exitDescription,
    });
    this.#rejectAllPending(exitError);
    this.#onReadyFailed?.(exitError);
    if (disposeFault !== null) {
      // After the cleanup, so a throwing sink cannot cost callers their rejections.
      this.#reportDisposeFailure(disposeFault.cause);
    }
  }

  /**
   * Reports a diagnostic contained (see `reportDiagnosticFromDetachedFrame`): these originate in
   * detached callbacks, where a throwing sink would be a daemon-fatal unhandled rejection.
   */
  #reportDiagnosticQuietly(diagnostic: CodexTransportDiagnostic): void {
    reportDiagnosticFromDetachedFrame(this.#reportDiagnostic, diagnostic);
  }

  #reportAnswerWriteFailure(method: string, cause: unknown): void {
    this.#reportDiagnosticQuietly({
      kind: "server-request-answer-write-failed",
      method,
      detail: normalizeProviderFailureDetail(cause),
    });
  }

  #reportDisposeFailure(cause: unknown): void {
    this.#reportDiagnosticQuietly({
      kind: "subscription-dispose-failed",
      detail: normalizeProviderFailureDetail(cause),
    });
  }

  #reportTeardownStepFailure(step: "pty-kill" | "pty-close", cause: unknown): void {
    this.#reportDiagnosticQuietly({
      kind: "teardown-step-failed",
      step,
      detail: normalizeProviderFailureDetail(cause),
    });
  }

  #clearReadyWait(): void {
    this.#onReady = null;
    this.#onReadyFailed = null;
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cancelDeadline();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
