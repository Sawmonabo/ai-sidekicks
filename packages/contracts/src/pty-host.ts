// PTY-host runtime-callable interface — daemon-side abstraction over the
// `pty-host-protocol.ts` wire envelope.
//
// Plan-024 splits the PTY surface into two contracts files per F-024-2-03:
//   • `pty-host-protocol.ts` — wire-format DTOs that mirror the Rust serde
//     structs in `packages/sidecar-rust-pty/src/protocol.rs`. `bytes`
//     fields are `string` carrying base64-encoded payloads; payload
//     variants carry a `kind` discriminant. Cross-environment safe.
//   • `pty-host.ts` (this file) — runtime-callable API for daemon-side
//     consumers (`packages/runtime-daemon/src/pty/`). `bytes` fields are
//     `Buffer` (decoded); methods take flat parameters rather than
//     envelopes. Daemon-only (Node context).
//
// Two backends implement `PtyHost` per Plan-024:
//   • `RustSidecarPtyHost` — spawns the Rust sidecar binary and marshals
//     over Content-Length framing (Plan-024 Phase 3).
//   • `NodePtyHost` — in-process `node-pty` fallback (Plan-024 Phase 2;
//     also the Phase-5 Windows fallback when the sidecar is unreachable).
//
// Refs: Plan-024 T-024-2-1, ADR-019 §Decision item 1.

import type { PtySignal, SpawnRequest, SpawnResponse } from "./pty-host-protocol.js";

export interface PtyHost {
  /**
   * Spawn a new PTY session. The daemon-layer `spawn-cwd-translator`
   * (Plan-001 §CP-001-2) rewrites `spec.cwd` to a stable parent
   * directory before this method runs, per I-024-5.
   */
  spawn(spec: SpawnRequest): Promise<SpawnResponse>;

  /** Adjust the PTY window dimensions for an existing session. */
  resize(sessionId: string, rows: number, cols: number): Promise<void>;

  /** Write a raw byte chunk to the PTY master fd. */
  write(sessionId: string, bytes: Buffer): Promise<void>;

  /**
   * Send `signal` to the session's child process. Windows backends
   * translate POSIX signals to console-control events + `taskkill`
   * escalation per Plan-024 §Windows Implementation Gotchas (I-024-1).
   */
  kill(sessionId: string, signal: PtySignal): Promise<void>;

  /** Tear down the session and release all per-session resources. */
  close(sessionId: string): Promise<void>;

  /**
   * Invoked when a data chunk arrives from `stdout` or `stderr` for the
   * named session. `chunk` is the base64-decoded payload of the
   * wire-side `DataFrame.bytes` from `pty-host-protocol.ts`.
   */
  onData(sessionId: string, chunk: Buffer): void;

  /**
   * Invoked when the session's child process exits. `signalCode` is the
   * numeric signal that terminated the child, if any (e.g. `15` for
   * `SIGTERM`); absent when the child exited normally with `exitCode`.
   */
  onExit(sessionId: string, exitCode: number, signalCode?: number): void;
}
