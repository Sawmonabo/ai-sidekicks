// PTY-host wire protocol — TS mirror of the Rust serde structs in
// `packages/sidecar-rust-pty/src/protocol.rs`.
//
// This module declares the wire-level discriminated union that crosses
// the Content-Length framing layer between the daemon and the Rust PTY
// sidecar (Plan-024). Every variant of `Envelope` corresponds to one
// `#[serde(tag = "kind")]` variant in the Rust enum; the `kind` literal
// is the on-wire discriminant per F-024-1-02.
//
// Hand-authored parity. No code-gen in V1 — see Plan-024 §Implementation
// Step 3: "two-sided hand edit vs adding a schema compiler; single
// schema compiler deferred to post-V1." When you edit one side, edit the
// other in the same commit.
//
// ## Field-shape decisions (mirror of Rust module docs)
//
//   • `SpawnRequest.env` is `Array<[string, string]>`, NOT
//     `Record<string, string>`. POSIX `execve` and Windows
//     `CreateProcess` preserve order and accept duplicate keys; a
//     record/map representation would silently dedupe and reorder.
//
//   • `WriteRequest.bytes` and `DataFrame.bytes` are `string` carrying
//     base64-encoded payloads per F-024-1-01. Decoding (e.g., via
//     `Buffer.from(b, "base64")`) is the consumer's responsibility —
//     this module is a pure wire-shape contract.
//
//   • `PingRequest` / `PingResponse` carry only the `kind` discriminant.
//     The plan does not pin a correlation field at this layer.
//
// No Zod schemas live in this module: wire validation happens at the
// daemon's framer layer (`packages/runtime-daemon/src/ipc/...`); the
// contracts package declares the shape only. This matches the Plan-024
// §Test And Verification Plan unit-test split (Rust side carries the
// round-trip burden via `protocol_roundtrip.rs`).
//
// Refs: Plan-024 §Target Areas / §Implementation Step 3, ADR-019
// §Decision item 1 (sidecar binary primary on Windows; protocol shape).

// --------------------------------------------------------------------------
// Shared discriminants
// --------------------------------------------------------------------------

/**
 * POSIX signal names accepted by `KillRequest.signal`. On Windows the
 * sidecar translates these to console-control events and `taskkill`
 * invocations per Plan-024 §Windows Implementation Gotchas; this
 * type is the on-wire shape only.
 */
export type PtySignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP";

/** Which standard stream a `DataFrame` carries. */
export type DataStream = "stdout" | "stderr";

// --------------------------------------------------------------------------
// Request / response payloads
// --------------------------------------------------------------------------

/**
 * Spawn a new PTY session.
 *
 * The daemon-layer `spawn-cwd-translator` (Plan-001 P5 CP-001-2)
 * rewrites `cwd` to a stable parent directory before this payload
 * reaches the sidecar (per I-024-5 / Plan-024 §Gotcha 5); the sidecar
 * forwards `cwd` verbatim to `portable-pty`.
 */
export interface SpawnRequest {
  kind: "spawn_request";
  command: string;
  args: string[];
  /**
   * Ordered key/value pairs. Process-spawn surfaces on every supported
   * platform preserve order and accept duplicate keys; a `Record`
   * representation would silently dedupe and reorder.
   */
  env: Array<[string, string]>;
  cwd: string;
  rows: number;
  cols: number;
}

/** Reply to a `SpawnRequest` — carries the sidecar-minted session id. */
export interface SpawnResponse {
  kind: "spawn_response";
  session_id: string;
}

/** Adjust the PTY window dimensions for an existing session. */
export interface ResizeRequest {
  kind: "resize_request";
  session_id: string;
  rows: number;
  cols: number;
}

/**
 * Acknowledgment of `ResizeRequest`. Explicit response per F-024-1-03
 * so request-correlation is symmetric across every control-message
 * kind.
 */
export interface ResizeResponse {
  kind: "resize_response";
  session_id: string;
}

/**
 * Write payload to a session's stdin.
 *
 * `bytes` is base64-encoded on the wire per F-024-1-01. Decode with
 * `Buffer.from(bytes, "base64")` or equivalent.
 */
export interface WriteRequest {
  kind: "write_request";
  session_id: string;
  /** Base64-encoded raw bytes — decoder is the consumer's responsibility. */
  bytes: string;
}

/** Acknowledgment of `WriteRequest`. Explicit response per F-024-1-03. */
export interface WriteResponse {
  kind: "write_response";
  session_id: string;
}

/**
 * Signal a session's child process.
 *
 * On Windows the sidecar translates per Plan-024 §Gotcha 1 + 2:
 * `SIGINT` → `CTRL_C_EVENT`, `SIGTERM` → `CTRL_BREAK_EVENT` then
 * `taskkill /T /F` on bounded timeout, `SIGKILL` → `taskkill /T /F`
 * directly, `SIGHUP` → ditto-treat-as-hard-stop.
 */
export interface KillRequest {
  kind: "kill_request";
  session_id: string;
  signal: PtySignal;
}

/**
 * Acknowledgment of `KillRequest`. Explicit response per F-024-1-03;
 * the sidecar acks once it has begun the kill cascade, NOT when the
 * child has actually exited — `ExitCodeNotification` carries the
 * terminal status.
 */
export interface KillResponse {
  kind: "kill_response";
  session_id: string;
}

/**
 * Terminal notification — emitted exactly once per session lifetime,
 * when the child process exits or is reaped. After this is sent the
 * sidecar drops the PTY pair and the session id is no longer valid.
 */
export interface ExitCodeNotification {
  kind: "exit_code_notification";
  session_id: string;
  exit_code: number;
  /**
   * Signal number for signal-terminated children on POSIX; absent (or
   * `null` on the wire — `Option::None` in Rust) for children that
   * exited normally. Windows always reports absent here.
   */
  signal_code: number | null;
}

/**
 * Liveness probe. No correlation field at this layer — the dispatcher
 * orders responses against requests on the single duplex stream.
 */
export interface PingRequest {
  kind: "ping_request";
}

/** Reply to a `PingRequest`. */
export interface PingResponse {
  kind: "ping_response";
}

/**
 * Asynchronous stdout/stderr chunk emitted by the sidecar.
 *
 * `seq` is monotonically increasing per `(session_id, stream)` pair
 * (per Plan-024 §Implementation Step 4); consumers reassemble a
 * stream in `seq` order. `bytes` is base64-encoded on the wire per
 * F-024-1-01.
 */
export interface DataFrame {
  kind: "data_frame";
  session_id: string;
  stream: DataStream;
  /**
   * Monotonically increasing per `(session_id, stream)` pair. The wire
   * type is `u64` in Rust; TS `number` is safe up to `2^53 - 1` which
   * is multiple lifetimes of PTY chunks at realistic rates. If the
   * sequence ever exceeds that, switch to a string-encoded bigint
   * before round-tripping through `JSON.parse`.
   */
  seq: number;
  /** Base64-encoded raw bytes — decoder is the consumer's responsibility. */
  bytes: string;
}

// --------------------------------------------------------------------------
// Wire envelope — discriminated on the `kind` field.
// --------------------------------------------------------------------------

/**
 * The complete set of messages that cross the framing layer.
 *
 * On the wire each variant serializes as a flat JSON object with `kind`
 * at the top level and the payload fields at the same depth. Use
 * narrowing on `envelope.kind` to discriminate:
 *
 * ```ts
 * switch (envelope.kind) {
 *   case "spawn_request": handleSpawn(envelope); break;
 *   case "data_frame":    handleData(envelope);  break;
 *   // ...
 * }
 * ```
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
