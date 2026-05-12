// Runtime-callable PTY-host interface — daemon-side abstraction over the
// `pty-host-protocol.ts` wire envelope.
//
// The contracts package carries two PTY surfaces:
//   • `pty-host-protocol.ts` — wire-format DTOs that mirror the Rust serde
//     structs (`bytes` fields are base64-encoded `string`; payload
//     variants carry a `kind` discriminant). Cross-environment safe.
//   • `pty-host.ts` (this file) — runtime API for daemon-side consumers.
//     `bytes` fields are `Uint8Array` (already decoded); methods take
//     flat parameters rather than envelopes. Daemon-only (Node context).
//
// Two backends implement the contract: a Rust sidecar binary marshalled
// over Content-Length framing, and an in-process `node-pty` fallback.

import type { PtySignal, SpawnRequest, SpawnResponse } from "./pty-host-protocol.js";

export interface PtyHost {
  /**
   * Spawn a new PTY session. The daemon-layer cwd-translator rewrites
   * `spec.cwd` to a stable parent directory before this method runs so
   * sidecar reads observe a stable cwd even when the underlying worktree
   * is torn down concurrently.
   */
  spawn(spec: SpawnRequest): Promise<SpawnResponse>;

  /** Adjust the PTY window dimensions for an existing session. */
  resize(sessionId: string, rows: number, cols: number): Promise<void>;

  /** Write a raw byte chunk to the PTY master fd. */
  write(sessionId: string, bytes: Uint8Array): Promise<void>;

  /**
   * Send `signal` to the session's child process. Windows backends
   * translate POSIX signals to console-control events
   * (`GenerateConsoleCtrlEvent` for `SIGINT`) and escalate hard-stops
   * via `taskkill /T /F`.
   */
  kill(sessionId: string, signal: PtySignal): Promise<void>;

  /** Tear down the session and release all per-session resources. */
  close(sessionId: string): Promise<void>;

  /**
   * Invoked when a data chunk arrives from `stdout` or `stderr` for the
   * named session. `chunk` is the base64-decoded payload of the
   * wire-side `DataFrame.bytes` from `pty-host-protocol.ts`.
   *
   * Ordering: MUST fire AFTER `spawn()` resolves for `sessionId` on the
   * consumer's await chain. Out-of-process backends with separate wire
   * channels for response dispatch vs. async events MUST buffer data
   * chunks observed on the wire before the matching `SpawnResponse`
   * frame and replay them on a separate I/O turn so the consumer's
   * `await spawn()` continuation runs first (otherwise `onData(id, ...)`
   * could fire before the consumer records `id` in its own state and
   * the chunk would be dropped). See I-024-6 in Plan-024 for the
   * `RustSidecarPtyHost` realization of this requirement.
   */
  onData(sessionId: string, chunk: Uint8Array): void;

  /**
   * Invoked when the session's child process exits. `signalCode` is the
   * numeric signal that terminated the child, if any (e.g. `15` for
   * `SIGTERM`); absent when the child exited normally with `exitCode`.
   * Adapters translate the wire-side `ExitCodeNotification.signal_code`
   * (`number | null`) — wire `null` is passed by omitting the third
   * argument.
   *
   * MUST fire exactly once for every session where `spawn()` returned a
   * successful `SpawnResponse`, regardless of how soon the child exits
   * relative to spawn-response delivery — including sub-millisecond-
   * lived children whose exit notification is observed on the wire
   * BEFORE the spawn-response frame. Out-of-process backends with
   * separate wire channels for response dispatch vs. async events MUST
   * buffer pre-spawn exit notifications keyed by `sessionId` and replay
   * them on a separate I/O turn after registering the session via
   * spawn-response handling, so the consumer's `await spawn()`
   * continuation runs first (otherwise `onExit(id, ...)` could fire
   * before the consumer records `id` in its own state). See I-024-6 in
   * Plan-024 for the `RustSidecarPtyHost` realization of this
   * requirement.
   *
   * MUST NOT fire after `close()` resolves for the same `sessionId`.
   */
  onExit(sessionId: string, exitCode: number, signalCode?: number): void;
}
