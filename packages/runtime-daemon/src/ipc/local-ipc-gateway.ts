// LocalIpcGateway: the JSON-RPC 2.0 substrate for the local daemon, over LSP-style
// `Content-Length: <bytes>\r\n\r\n` framing on a Unix domain socket or Windows named pipe.
//
// * The framing parser rejects malformed frames at the boundary, so handlers only ever see
//   well-formed JSON-RPC envelopes.
// * Every error response goes through `mapJsonRpcError`, which picks the numeric code and strips
//   stack traces and absolute paths; the gateway only routes thrown values to it.
// * The message cap, `MAX_MESSAGE_BYTES`, is fixed in the substrate; changing it changes the wire
//   contract.
// * `MethodRegistry` is injected at construction. `DaemonHello` version negotiation lives in
//   `protocol-negotiation.ts` and streaming in `streaming-primitive.ts`.
// * `protocolVersion` is an ISO 8601 `YYYY-MM-DD` date string.

import * as net from "node:net";

import type { HandlerContext, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcResponse,
} from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import {
  ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS,
  isJsonRpcIdWithinBound,
  JSON_RPC_ID_MAX_BYTES,
  JSONRPC_VERSION,
  MAX_MESSAGE_BYTES,
} from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import { PROTOCOL_VERSION_REGEX } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import {
  encodeFrame,
  FrameAccumulator,
  FramingError,
} from "@ai-sidekicks/contracts/content-length-framing";

import { assertLoadedForBind } from "../bootstrap/index.js";
import { assertSocketPathFits, SecureDefaults } from "../bootstrap/secure-defaults.js";
import { mapJsonRpcError } from "./jsonrpc-error-mapping.js";
import { readSocketPathLimit } from "./socket-path-limit.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * How long a stop lets each connection send what is already written to it, a stop's own reply
 * among them, before it cuts the connection. A local socket hands over a reply at once; only a
 * client that stopped reading holds a connection this long.
 */
const CONNECTION_CLOSE_WAIT_MS = 500;

/**
 * The largest accepted or emitted frame body, in bytes. The value lives in
 * `@ai-sidekicks/contracts` so a producer sizing a reply shares it with the framer; inbound
 * enforcement is only here, where the gateway hands it to `parseFrame` as the body limit, and the
 * shared `encodeFrame` refuses to emit an oversized body.
 */
export { MAX_MESSAGE_BYTES };

/**
 * The ceiling on a JSON-RPC `id`, in JSON-encoded bytes. The value lives in
 * `@ai-sidekicks/contracts` because a paged reply subtracts it from its own budget; the accept or
 * refuse decision is only here, at two sites. `#dispatchFrame` refuses an over-bound id as
 * `-32600` before dispatch. `extractIdSafely` drops one to `null`, because the earlier envelope
 * gates (`jsonrpc`, `method`) answer before the id gate and would otherwise echo the oversized id
 * into an error frame that cannot be sent.
 */
export { JSON_RPC_ID_MAX_BYTES };

// --------------------------------------------------------------------------
// Supervision surface
// --------------------------------------------------------------------------

/**
 * The handle passed to supervision hooks for one connection: opaque to consumers, who use it only
 * to correlate `onConnect`, `onDisconnect` and `onError`. `id` is a process-monotonic integer
 * assigned at connect time and stable for the connection's life.
 */
interface SupervisionTransport {
  readonly id: number;
}

/**
 * Why a connection ended, as a closed union. `"client_close"` is the peer closing;
 * `"server_close"` is a deliberate gateway close (`stop()`, or an outbound frame that could not be
 * encoded); `"transport_error"` is a socket `error` event, after which `onError` has fired;
 * `"oversized_body"` is a declared `Content-Length` over `MAX_MESSAGE_BYTES`; `"malformed_frame"`
 * is any other framing violation.
 */
export type SupervisionDisconnectReason =
  | "client_close"
  | "server_close"
  | "transport_error"
  | "oversized_body"
  | "malformed_frame";

/**
 * Callbacks that observe the connection lifecycle; `onConnect` is optional. All are synchronous,
 * and a throwing callback is a programmer error that the gateway does not swallow. Each
 * connection's `onError` is followed by exactly one `onDisconnect` for the same transport.
 */
export interface SupervisionHooks {
  onConnect?(transport: SupervisionTransport): void;
  onDisconnect(transport: SupervisionTransport, reason: SupervisionDisconnectReason): void;
  onError(transport: SupervisionTransport, err: unknown): void;
}

// --------------------------------------------------------------------------
// Error-message sanitization
// --------------------------------------------------------------------------

/**
 * Reduce any thrown value to a string safe to send as `error.message`. An `Error` contributes its
 * `.message` only, never `.stack`; anything else goes through `String(value)`. Unix, UNC and
 * Windows-drive paths become `<redacted-path>` (see {@link redactPathsFromString}), and the result
 * is capped at `SANITIZED_MESSAGE_MAX_LEN`.
 *
 * It never throws: a hostile value whose `toString` throws would otherwise escape as an unhandled
 * rejection, so it yields `"<unprintable thrown value>"`. It does not catch secrets that do not
 * look like paths; handler authors keep those out of messages. Because Windows and UNC segments
 * may contain spaces, prose that directly follows such a path can be over-redacted, which is the
 * safe direction.
 */
export function sanitizeErrorMessage(value: unknown): string {
  let raw: string;
  if (value instanceof Error) {
    // Never `.stack`: it leaks file paths, function names and module structure.
    raw = value.message;
  } else if (typeof value === "string") {
    raw = value;
  } else {
    // `String(value)` is printable for null, undefined and plain objects without exposing
    // structured fields, but it calls `toString`, which a hostile thrown object can make throw.
    try {
      raw = String(value);
    } catch {
      raw = "<unprintable thrown value>";
    }
  }

  const sanitized = redactPathsFromString(raw);

  if (sanitized.length > SANITIZED_MESSAGE_MAX_LEN) {
    const truncationMarker = "…[truncated]";
    const keptLength = SANITIZED_MESSAGE_MAX_LEN - truncationMarker.length;
    return `${sanitized.slice(0, keptLength)}${truncationMarker}`;
  }
  return sanitized;
}

/**
 * Replace Unix absolute paths, UNC paths and Windows-drive paths with `<redacted-path>`. It is
 * shared by `sanitizeErrorMessage` and `sanitizeFields` so both channels redact the same way. Each
 * pattern accepts an optional `:line:col` trailer for stack-frame-shaped text.
 *
 * Unix segments exclude spaces, which end a path token. UNC hosts also exclude spaces, but UNC
 * share and path segments and Windows-drive segments allow them (`\\fs\Shared Drive\a.json`,
 * `C:\Program Files\a.exe`). It never throws and is idempotent, since `<redacted-path>` matches
 * none of the patterns. Each quantifier body is a bounded character class over disjoint segments,
 * so backtracking stays linear on pathological input such as `'/'.repeat(N)`.
 */
export function redactPathsFromString(input: string): string {
  // Unix: conservative character class, so it stops at whitespace, quotes and similar. A path
  // starts at a token boundary, so a slash inside a name (`feature/login`) is not one.
  let sanitized = input.replace(
    /(?<![A-Za-z0-9_.-])(?:\/[A-Za-z0-9_.-]+)+(?::\d+(?::\d+)?)?/g,
    "<redacted-path>",
  );
  // UNC: the host has no spaces, the share and path segments may.
  sanitized = sanitized.replace(
    /\\\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_. -]+)+(?::\d+(?::\d+)?)?/g,
    "<redacted-path>",
  );
  // Windows drive: segments may contain spaces; `-` is last in the class so it is not a range.
  sanitized = sanitized.replace(
    /[A-Za-z]:\\(?:[A-Za-z0-9_. -]+\\?)+(?::\d+(?::\d+)?)?/g,
    "<redacted-path>",
  );
  return sanitized;
}

/**
 * Cap on a sanitized error message, so a pathological thrown string cannot push the response past
 * `MAX_MESSAGE_BYTES`.
 */
export const SANITIZED_MESSAGE_MAX_LEN = 8192;

// --------------------------------------------------------------------------
// Internal: per-connection state
// --------------------------------------------------------------------------

interface ConnectionState {
  readonly transport: SupervisionTransport;
  readonly socket: net.Socket;
  /** The connection's received bytes not yet framed; no state is shared across sockets. */
  readonly frames: FrameAccumulator;
  /** Set once `onDisconnect` has fired, so a late socket event cannot fire it twice. */
  disposed: boolean;
}

// Decoding keeps no state between calls, so every connection shares one decoder.
const UTF8_DECODER = new TextDecoder();

let nextTransportId = 1;
function allocTransportId(): number {
  return nextTransportId++;
}

// --------------------------------------------------------------------------
// LocalIpcGateway
// --------------------------------------------------------------------------

/**
 * Configuration for `LocalIpcGateway`. Optional fields are omitted rather than set to `undefined`
 * (`exactOptionalPropertyTypes`). `registry` is required and injected, so the gateway never owns
 * registry construction; `hooks` is optional supervision.
 */
export interface LocalIpcGatewayOptions {
  readonly registry: MethodRegistry;
  readonly hooks?: SupervisionHooks;
}

/**
 * A JSON-RPC listener on the local IPC path that frames, validates and dispatches requests to the
 * injected `MethodRegistry`. It is instantiable rather than a singleton because it owns I/O
 * resources (a `net.Server`, sockets, buffers) with their own lifecycle, and a test builds an
 * isolated instance per case.
 */
export class LocalIpcGateway {
  readonly #registry: MethodRegistry;
  readonly #hooks: SupervisionHooks | null;
  #server: net.Server | null;
  #connections: Map<number, ConnectionState>;
  #started: boolean;

  constructor(options: LocalIpcGatewayOptions) {
    this.#registry = options.registry;
    this.#hooks = options.hooks ?? null;
    this.#server = null;
    this.#connections = new Map();
    this.#started = false;
  }

  /**
   * Bind the listener to the path in `SecureDefaults.effectiveSettings()`. Rejects if
   * `SecureDefaults.load` has not completed, if the gateway is already started, with
   * `invalid_local_ipc_path` before the bind when the path is longer than the platform's socket
   * address field, or on a bind failure such as EADDRINUSE; a failed start leaves the instance
   * unstarted so `start()` can be retried.
   */
  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("LocalIpcGateway.start: gateway already started");
    }

    // Checked first so a misconfigured bootstrap throws before any I/O resource is allocated.
    assertLoadedForBind();

    const settings = SecureDefaults.effectiveSettings();
    const listenPath = settings.localIpcPath;
    // A Unix domain socket path must fit the platform's address field; a Windows pipe name has no
    // such field.
    if (process.platform !== "win32") {
      assertSocketPathFits(listenPath, await readSocketPathLimit());
    }

    const server = net.createServer((socket) => {
      this.#onSocketConnect(socket);
    });

    server.on("error", (err) => {
      // Server-level errors have no connection, so supervision gets a synthetic transport (id 0).
      if (this.#hooks !== null) {
        this.#hooks.onError({ id: 0 }, err);
      }
    });

    // `#server` and `#started` are set only after the listen resolves, so a failed bind leaves the
    // instance retryable. The persistent `error` listener above still reports the failed bind.
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.removeListener("error", onListenError);
        resolve();
      };
      const onListenError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onListenError);
      server.listen(listenPath);
    });

    this.#server = server;
    this.#started = true;
  }

  /**
   * Close the listener and every open connection, each of which fires
   * `onDisconnect(transport, "server_close")`. The listener closes first, so no connection arrives
   * during the stop; each open connection then sends what is already written to it, within a short
   * wait, so a stop's own reply reaches its client, and nothing more it receives is run. Unlike
   * `start()`, it is idempotent and a no-op on an unstarted or stopped gateway, so error handlers
   * can call it without knowing the state.
   */
  async stop(): Promise<void> {
    if (!this.#started || this.#server === null) {
      return;
    }

    const server = this.#server;
    this.#server = null;
    this.#started = false;
    // The close's callback waits for every connection to end, so it settles with them.
    const listenerClosed = new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== null && err !== undefined) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Snapshot: disconnecting mutates the map.
    const connections = Array.from(this.#connections.values());
    const closings = connections.map((conn) => {
      this.#emitDisconnect(conn, "server_close");
      return closeAfterSending(conn.socket);
    });
    this.#connections.clear();

    await Promise.all([listenerClosed, ...closings]);
  }

  /**
   * Writes one notification to one connection, as a subscription's values go out. A connection
   * that has already closed takes nothing: its subscriptions end with it, so a value in flight
   * as it closed has no reader.
   */
  notify(transportId: number, notification: JsonRpcNotification<unknown>): void {
    const state = this.#connections.get(transportId);
    if (state === undefined) {
      return;
    }
    this.#sendEnvelope(state, notification);
  }

  // ------------------------------------------------------------------------
  // Per-connection wiring
  // ------------------------------------------------------------------------

  #onSocketConnect(socket: net.Socket): void {
    const transport: SupervisionTransport = { id: allocTransportId() };
    const state: ConnectionState = {
      transport,
      socket,
      frames: new FrameAccumulator(MAX_MESSAGE_BYTES),
      disposed: false,
    };
    this.#connections.set(transport.id, state);

    if (this.#hooks !== null) {
      this.#hooks.onConnect?.(transport);
    }

    socket.on("data", (chunk: Buffer) => {
      this.#onSocketData(state, chunk);
    });
    socket.on("end", () => {
      this.#emitDisconnect(state, "client_close");
    });
    socket.on("close", () => {
      // `close` follows `end` or `error`; the disposed flag drops the duplicate.
      this.#emitDisconnect(state, "client_close");
    });
    socket.on("error", (err) => {
      // Node can emit an `error` after `close` (such as ECONNRESET during teardown). Once
      // disposed, `#emitDisconnect` is suppressed, so reporting it would leave a dangling
      // `onError` with no matching `onDisconnect`.
      if (state.disposed) {
        return;
      }
      if (this.#hooks !== null) {
        this.#hooks.onError(transport, err);
      }
      this.#emitDisconnect(state, "transport_error");
    });
  }

  #onSocketData(state: ConnectionState, chunk: Buffer): void {
    // A disconnected connection runs nothing more: its reply would be dropped, so its client could
    // not tell whether a write landed, and a subscription opened now would never be cleaned up.
    if (state.disposed) {
      return;
    }
    state.frames.append(chunk);
    // One chunk can carry several frames, since a stream has no message boundaries.
    for (;;) {
      let frame: Uint8Array | null;
      try {
        frame = state.frames.nextFrame();
      } catch (err) {
        // The wire is desynced and the peer cannot recover, so send a best-effort error response
        // with id null and then close.
        const reason: SupervisionDisconnectReason =
          err instanceof FramingError && err.code === "oversized_body"
            ? "oversized_body"
            : "malformed_frame";
        try {
          if (this.#hooks !== null) {
            this.#hooks.onError(state.transport, err);
          }
        } finally {
          // Tear-down runs even if a supervision hook throws (the throw still propagates).
          // Otherwise the socket would stay open with a corrupt accumulator and every later `data`
          // event would fail on the same boundary. The send is best-effort because the socket is
          // about to be destroyed, and `mapJsonRpcError` does not throw.
          this.#sendEnvelope(state, mapJsonRpcError(err, null));
          this.#emitDisconnect(state, reason);
          state.socket.destroy();
        }
        return;
      }
      if (frame === null) {
        // Wait for the next `data` event.
        return;
      }
      this.#dispatchFrame(state, frame);
    }
  }

  #dispatchFrame(state: ConnectionState, body: Uint8Array): void {
    // A body that is not valid JSON is a `-32700` parse error with id null. The connection stays
    // open: the framing was intact, so the next frame may parse.
    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8_DECODER.decode(body)) as unknown;
    } catch (err) {
      const wrapped = new FramingError(
        "invalid_json",
        err instanceof Error ? err.message : String(err),
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
      return;
    }

    // Envelope-shape failures are `-32600`. Full params validation happens in the registry.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const wrapped = new FramingError(
        "invalid_envelope",
        "invalid JSON-RPC envelope: not an object",
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
      return;
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope["jsonrpc"] !== JSONRPC_VERSION) {
      const wrapped = new FramingError(
        "invalid_envelope",
        `invalid JSON-RPC envelope: jsonrpc must equal ${JSONRPC_VERSION}`,
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, extractIdSafely(envelope)));
      return;
    }
    // A request must carry a string `method`.
    const methodCandidate = envelope["method"];
    if (typeof methodCandidate !== "string") {
      const wrapped = new FramingError(
        "invalid_envelope",
        "invalid JSON-RPC envelope: method must be a string",
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, extractIdSafely(envelope)));
      return;
    }

    // A notification has no `id` member. `extractIdSafely` returns `null` for both a missing and
    // an invalid id, so only the `in` check tells them apart.
    const isNotification = !("id" in envelope);
    // A present `id` that is not a string, number or null is a `-32600` malformed request. Without
    // this gate `{"id": {}}` would reach the handler, and `extractIdSafely` would quietly turn the
    // bad id into `null` in the response.
    if (!isNotification) {
      const idCandidate = envelope["id"];
      if (
        typeof idCandidate !== "string" &&
        typeof idCandidate !== "number" &&
        idCandidate !== null
      ) {
        const wrapped = new FramingError(
          "invalid_envelope",
          "invalid JSON-RPC envelope: id must be string, number, or null",
        );
        this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
        return;
      }
      // Bound the id: the response echoes it verbatim, so it is the one response member the caller
      // sizes. An id that fits the inbound frame can still make every reply un-encodable, and
      // `#sendEnvelope` then destroys the socket, so a caller could drop its own session and no
      // response schema could prevent it. The error frame carries id null, not the offending
      // value, since echoing it is the write this gate exists to prevent.
      if (!isJsonRpcIdWithinBound(idCandidate)) {
        const wrapped = new FramingError(
          "invalid_envelope",
          `invalid JSON-RPC envelope: id exceeds ${JSON_RPC_ID_MAX_BYTES} bytes once encoded`,
        );
        this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
        return;
      }
    }
    const requestId: JsonRpcId = isNotification ? null : extractIdSafely(envelope);
    const params = envelope["params"];

    // Every request except the handshake must carry a valid envelope-level `protocolVersion`;
    // `daemon.hello` is exempt because its version rides in `params` (see
    // `ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS`). This gate runs after the id-shape gate so a bad
    // id still reports `invalid_envelope`; keep that order.
    //
    // `data.fields.reason` is `missing`, `wrong_type` or `invalid_format`. The offending value is
    // never echoed; `wrong_type` carries only the JS typeof tag. A JSON `null` is `wrong_type`
    // because the field is present. A notification with a bad version is dropped and reported
    // through `onError`, unless the peer already disconnected (an `onError` after `onDisconnect`
    // would dangle).
    if (!ENVELOPE_PROTOCOL_VERSION_EXEMPT_METHODS.has(methodCandidate)) {
      const pvCandidate = envelope["protocolVersion"];
      let pvReason: "missing" | "wrong_type" | "invalid_format" | null = null;
      let pvObservedType: string | null = null;
      if (pvCandidate === undefined) {
        pvReason = "missing";
      } else if (typeof pvCandidate !== "string") {
        pvReason = "wrong_type";
        pvObservedType = pvCandidate === null ? "null" : typeof pvCandidate;
      } else if (!PROTOCOL_VERSION_REGEX.test(pvCandidate)) {
        pvReason = "invalid_format";
      }
      if (pvReason !== null) {
        const fields: Record<string, unknown> =
          pvObservedType !== null
            ? { reason: pvReason, observedType: pvObservedType }
            : { reason: pvReason };
        const wrapped = new FramingError(
          "invalid_protocol_version",
          `invalid JSON-RPC envelope: protocolVersion ${pvReason}`,
          fields,
        );
        if (isNotification) {
          if (state.disposed) return;
          if (this.#hooks !== null) {
            this.#hooks.onError(state.transport, wrapped);
          }
          return;
        }
        this.#sendEnvelope(state, mapJsonRpcError(wrapped, requestId));
        return;
      }
    }

    // Dispatch resolves with the handler's result, or rejects with a `RegistryDispatchError` or
    // whatever the handler threw; both paths reply through `#sendEnvelope`. The read loop does not
    // wait, so several dispatches can be in flight per connection: JSON-RPC promises no order
    // beyond id correlation.
    const ctx: HandlerContext = { transportId: state.transport.id };
    this.#registry.dispatch(methodCandidate, params, ctx).then(
      (result: unknown) => {
        if (isNotification) {
          // A notification gets no response.
          return;
        }
        const response: JsonRpcResponse = {
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          result,
        };
        this.#sendEnvelope(state, response);
      },
      (err: unknown) => {
        if (isNotification) {
          // A notification gets no response, so a handler failure is reported through
          // supervision. As in the socket `error` listener, a disposed connection is skipped so
          // `onError` never follows `onDisconnect`.
          if (state.disposed) return;
          if (this.#hooks !== null) {
            this.#hooks.onError(state.transport, err);
          }
          return;
        }
        // `#sendEnvelope` drops replies to a disposed connection, so no disposed check is needed
        // here.
        this.#sendEnvelope(state, mapJsonRpcError(err, requestId));
      },
    );
  }

  // ------------------------------------------------------------------------
  // Outbound emission
  // ------------------------------------------------------------------------

  /**
   * The single outbound seam: every response, error response and notification is written here.
   * Error envelopes come from `mapJsonRpcError`, which sanitizes them. Nothing is sent once the
   * connection is disposed.
   */
  #sendEnvelope(
    state: ConnectionState,
    envelope: JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification<unknown>,
  ): void {
    if (state.disposed) {
      return;
    }
    let frame: Uint8Array;
    try {
      frame = encodeFrame(envelope);
    } catch (err) {
      // The reply that failed to encode cannot be sent, so report to supervision and disconnect.
      // Tear-down runs even if `onError` throws, or the socket would stay open and leak its map
      // entry.
      try {
        if (this.#hooks !== null) {
          this.#hooks.onError(state.transport, err);
        }
      } finally {
        this.#emitDisconnect(state, "server_close");
        state.socket.destroy();
      }
      return;
    }
    state.socket.write(frame);
  }

  #emitDisconnect(state: ConnectionState, reason: SupervisionDisconnectReason): void {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    this.#connections.delete(state.transport.id);
    if (this.#hooks !== null) {
      this.#hooks.onDisconnect(state.transport, reason);
    }
  }
}

// --------------------------------------------------------------------------
// Helpers (private)
// --------------------------------------------------------------------------

/**
 * The request `id` to echo into an error envelope, or `null` when it is missing, malformed or
 * over the id bound. JSON-RPC requires Null when the id cannot be recovered.
 */
function extractIdSafely(envelope: Record<string, unknown>): JsonRpcId {
  const candidate = envelope["id"];
  if (typeof candidate === "string" || typeof candidate === "number" || candidate === null) {
    // An over-bound id is not echoed: the callers build error frames for envelopes that failed an
    // earlier gate (`jsonrpc`, `method`), which answer before the id-bound refusal, so echoing
    // would make the one frame that must be small the one that closes the connection.
    return isJsonRpcIdWithinBound(candidate) ? candidate : null;
  }
  return null;
}

// Ends the socket, which sends what is already written to it and then closes it, and destroys it
// if it has not closed within the wait.
function closeAfterSending(socket: net.Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.closed) {
      resolve();
      return;
    }
    const cutTimer = setTimeout(() => {
      socket.destroy();
    }, CONNECTION_CLOSE_WAIT_MS);
    socket.once("close", () => {
      clearTimeout(cutTimer);
      resolve();
    });
    socket.end();
  });
}
