// TypeScript mirror of the Rust serde structs in `packages/sidecar-rust-pty/src/protocol.rs`: the
// messages that cross the Content-Length framing layer between the daemon and the PTY sidecar.
// Each `Envelope` variant matches one `#[serde(tag = "kind")]` variant in Rust, and `kind` is the
// on-wire discriminant. There is no code generation, so an edit to one side is made to the other
// in the same commit. No Zod schemas live here; the daemon's framer validates the wire.
//
// Field-shape rules:
// - `SpawnRequest.env` is an array of pairs, not a record: process spawn preserves order and
//   accepts duplicate keys, which a record would silently dedupe and reorder.
// - `bytes` fields are base64 strings; decoding is the consumer's job.
// - `SpawnResponse`, `ResizeResponse`, `WriteResponse` and `KillResponse` carry `error?: string`,
//   absent on the wire when the handler succeeded. `ExitCodeNotification.signal_code` differs: it
//   is `null` on the wire when absent, because there absent is a meaningful value. Without a typed
//   error response the daemon's awaiting request would hang, since `sendRequest` has no timeout.

/** POSIX signal names accepted by `KillRequest.signal`; the on-wire shape only. */
export type PtySignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP";

/** Which standard stream a `DataFrame` carries. */
export type DataStream = "stdout" | "stderr";

/**
 * Spawn a new PTY session. The daemon's `spawn-cwd-translator` rewrites `cwd` before this reaches
 * the sidecar, which forwards it verbatim to `portable-pty`.
 */
export interface SpawnRequest {
  kind: "spawn_request";
  command: string;
  args: string[];
  /** Ordered key/value pairs; a `Record` would dedupe and reorder them. */
  env: Array<[string, string]>;
  cwd: string;
  rows: number;
  cols: number;
}

/**
 * Reply to a `SpawnRequest`: the sidecar-minted session id, or `error` when the spawn failed
 * (nonexistent command, exec permission denied). On failure `session_id` is an empty string, no
 * session was minted, and the daemon must not track it.
 */
export interface SpawnResponse {
  kind: "spawn_response";
  session_id: string;
  /** Present only when the sidecar's handler failed; the daemon rejects the awaiting request. */
  error?: string;
}

/** Adjust the PTY window dimensions for an existing session. */
export interface ResizeRequest {
  kind: "resize_request";
  session_id: string;
  rows: number;
  cols: number;
}

/**
 * Reply to a `ResizeRequest`. `error` is set when the handler failed, most often `UnknownSession`
 * because the session exited before the sidecar dispatched the request.
 */
export interface ResizeResponse {
  kind: "resize_response";
  session_id: string;
  /** Present only when the sidecar's handler failed; the daemon rejects the awaiting request. */
  error?: string;
}

/** Write payload to a session's stdin; `bytes` is base64-encoded on the wire. */
export interface WriteRequest {
  kind: "write_request";
  session_id: string;
  /** Base64-encoded raw bytes. */
  bytes: string;
}

/**
 * Reply to a `WriteRequest`. `error` is set when the handler failed: `UnknownSession` (the session
 * exited) or `WriterUnavailable` (the per-session writer was already taken).
 */
export interface WriteResponse {
  kind: "write_response";
  session_id: string;
  /** Present only when the sidecar's handler failed; the daemon rejects the awaiting request. */
  error?: string;
}

/**
 * Signal a session's child process. On Windows the sidecar's kill currently returns an error; the
 * intended mapping is `SIGINT` to `CTRL_C_EVENT`, `SIGTERM` to `CTRL_BREAK_EVENT` then
 * `taskkill /T /F` on timeout, and `SIGKILL` or `SIGHUP` to `taskkill /T /F` directly.
 */
export interface KillRequest {
  kind: "kill_request";
  session_id: string;
  signal: PtySignal;
}

/**
 * Reply to a `KillRequest`, sent once the kill has begun, not when the child has exited:
 * `ExitCodeNotification` carries the final status. `error` is set when the handler failed, most
 * often `UnknownSession` because the session exited while the daemon's request was in flight,
 * a race the daemon cannot avoid.
 */
export interface KillResponse {
  kind: "kill_response";
  session_id: string;
  /** Present only when the sidecar's handler failed; the daemon rejects the awaiting request. */
  error?: string;
}

/**
 * Sent exactly once per session when the child exits or is reaped. After it the sidecar drops the
 * PTY pair and the session id is no longer valid.
 */
export interface ExitCodeNotification {
  kind: "exit_code_notification";
  session_id: string;
  exit_code: number;
  /**
   * Signal number of a signal-terminated child, or `null`. The sidecar currently sends `null` for
   * every exit because `portable-pty` discards the signal number.
   */
  signal_code: number | null;
}

/** Liveness probe. It has no correlation field; a response matches the oldest pending ping. */
export interface PingRequest {
  kind: "ping_request";
}

/** Reply to a `PingRequest`. */
export interface PingResponse {
  kind: "ping_response";
}

/** Asynchronous stdout or stderr chunk from the sidecar; `bytes` is base64-encoded on the wire. */
export interface DataFrame {
  kind: "data_frame";
  session_id: string;
  stream: DataStream;
  /**
   * Increases per `(session_id, stream)` pair; consumers reassemble in `seq` order. Rust sends a
   * `u64`; a TS `number` is exact only up to `2^53 - 1`, far beyond realistic chunk counts.
   */
  seq: number;
  /** Base64-encoded raw bytes. */
  bytes: string;
}

/**
 * The complete set of messages that cross the framing layer. Each variant is a flat JSON object
 * with `kind` beside its payload fields; narrow on `envelope.kind`.
 */
export type Envelope =
  | SpawnRequest
  | SpawnResponse
  | ResizeRequest
  | ResizeResponse
  | WriteRequest
  | WriteResponse
  | KillRequest
  | KillResponse
  | ExitCodeNotification
  | PingRequest
  | PingResponse
  | DataFrame;
