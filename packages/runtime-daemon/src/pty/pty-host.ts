// Runtime API of a PTY host, for daemon-side consumers in Node. It differs from the wire types in
// `pty-host-protocol.ts`: `bytes` are decoded `Uint8Array`s and methods take flat parameters
// instead of envelopes. Two backends implement it: a Rust sidecar binary over Content-Length
// framing, and an in-process `node-pty` fallback.

import type { PtySignal, SpawnRequest, SpawnResponse } from "./pty-host-protocol.js";

/** A PTY backend the daemon uses to spawn, drive and drain terminal sessions. */
export interface PtyHost {
  /**
   * Spawn a new PTY session. The daemon's cwd translator rewrites `spec.cwd` to a stable parent
   * directory first, so the spawn sees a stable cwd even if the worktree is torn down meanwhile.
   */
  spawn(spec: SpawnRequest): Promise<SpawnResponse>;

  /** Adjust the PTY window dimensions for an existing session. */
  resize(sessionId: string, rows: number, cols: number): Promise<void>;

  /** Write a raw byte chunk to the PTY master fd. */
  write(sessionId: string, bytes: Uint8Array): Promise<void>;

  /**
   * Send `signal` to the session's child process. Windows backends translate POSIX signals to
   * console-control events (`GenerateConsoleCtrlEvent` for `SIGINT`) and escalate hard stops
   * through `taskkill /T /F`.
   */
  kill(sessionId: string, signal: PtySignal): Promise<void>;

  /** Tear down the session and release all per-session resources. */
  close(sessionId: string): Promise<void>;

  /**
   * Drain all active sessions and shut down host-level resources before the daemon or Electron main
   * exits; the host-level counterpart of `close(sessionId)`. Implementations must:
   *
   * 1. For every active session, send a graceful `SIGTERM`, wait up to `perSessionTimeoutMs` for
   *    the child to exit, then escalate to `SIGKILL` (`taskkill /T /F` on Windows), counting the
   *    session in `sessionsDrained` or `sessionsForcedKilled`.
   * 2. For an out-of-process backend, after all sessions drain, close the sidecar's stdin, wait up
   *    to `hostTimeoutMs` for it to exit, and escalate to `taskkill /T /F /PID <sidecar-pid>`;
   *    report the outcome in `sidecarExitedCleanly` and `taskkillEscalated`. An in-process backend
   *    has no sidecar and reports `sidecarExitedCleanly: true, taskkillEscalated: false`.
   * 3. Be idempotent: a second call returns the in-flight first call's promise instead of starting
   *    another drain.
   *
   * Shutdown is terminal: afterward the host refuses new `spawn()` calls, and an out-of-process
   * backend does not respawn the sidecar, because its exit is deliberate. That exit also does not
   * count against the crash budget (`RustSidecarPtyHost` only): no `-1` crash sentinel is emitted
   * and the crash is not recorded. The two timeouts are independent budgets, since per-session
   * drain is dominated by child cleanup and host drain by sidecar wind-down.
   */
  shutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult>;

  /**
   * Invoked for each stdout or stderr chunk of a session; `chunk` is the decoded
   * `DataFrame.bytes`. It fires only after `spawn()` resolves for `sessionId`: an out-of-process
   * backend buffers chunks that arrive before the matching `SpawnResponse` and releases them on a
   * later turn, or the consumer would see data for a session id it has not recorded yet.
   */
  onData(sessionId: string, chunk: Uint8Array): void;

  /**
   * Invoked when the session's child exits. `signalCode` is the signal that terminated the child
   * (for example `15` for `SIGTERM`) and is omitted when the wire value is `null`.
   *
   * It fires exactly once for every session whose `spawn()` succeeded, even for a child that exits
   * before the spawn response arrives: an out-of-process backend buffers such early exits by
   * `sessionId` and releases them on a later turn, after the consumer's `await spawn()` continues.
   * A `kill()` on a session whose child has already exited sends nothing and does not fire it
   * again. It never fires after `close()` resolves for the same `sessionId`.
   */
  onExit(sessionId: string, exitCode: number, signalCode?: number): void;
}

/**
 * Result of a `PtyHost.shutdown()` drain at the service's stop, which the daemon writes to its
 * service log: whether each terminal ended on its graceful signal or was killed, and whether the
 * terminal host exited on its own or was killed.
 *
 * `sessionsDrained + sessionsForcedKilled` equals the sessions active when shutdown began; sessions
 * that had already exited count in neither. `taskkillEscalated` records that the daemon issued the
 * `taskkill`, not that it succeeded, so it can be true when `sidecarExitedCleanly` is false.
 */
export interface DrainResult {
  /** Sessions that exited on `SIGTERM` within the per-session timeout. */
  readonly sessionsDrained: number;
  /**
   * Sessions whose per-session timeout expired before the graceful kill produced an exit, so the
   * host escalated to `SIGKILL` or `taskkill /T /F`. Their `onExit` still fires.
   */
  readonly sessionsForcedKilled: number;
  /**
   * True when the sidecar exited within the host timeout after the daemon closed its stdin.
   * Vacuously true for an in-process backend.
   */
  readonly sidecarExitedCleanly: boolean;
  /**
   * True when the daemon issued `taskkill /T /F /PID <sidecar-pid>` (or the platform equivalent)
   * against the sidecar. Vacuously false for an in-process backend and for a sidecar that exited
   * cleanly; whether the OS kill itself succeeded is not tracked.
   */
  readonly taskkillEscalated: boolean;
}
