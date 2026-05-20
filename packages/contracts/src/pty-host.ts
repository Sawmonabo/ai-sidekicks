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
   * Drain all active sessions and shut down host-level resources in
   * preparation for daemon / Electron-main termination. The polymorphic
   * counterpart to `close(sessionId)` for the lifecycle level above the
   * per-session axis.
   *
   * Implementations MUST:
   *   1. For every active session: dispatch a graceful per-session kill
   *      (`SIGTERM`), wait up to `options.perSessionTimeoutMs` for the
   *      session's child to exit, escalate to `SIGKILL` (the platform's
   *      `taskkill /T /F` on Windows) if the timeout fires, and record
   *      whether the session drained gracefully (`sessionsDrained`) or
   *      was force-killed (`sessionsForcedKilled`).
   *   2. For out-of-process backends (`RustSidecarPtyHost`): after all
   *      per-session drains complete, close the sidecar's stdin and
   *      wait up to `options.hostTimeoutMs` for the sidecar process to
   *      exit; escalate to `taskkill /T /F /PID <sidecar-pid>` if the
   *      host timeout fires; report the outcome via
   *      `sidecarExitedCleanly` and `taskkillEscalated`. In-process
   *      backends (`NodePtyHost`) have no sidecar to drain and MUST
   *      vacuously report `sidecarExitedCleanly: true,
   *      taskkillEscalated: false`.
   *   3. Be idempotent and re-entrant: a second `shutdown()` call MUST
   *      return the same `Promise<DrainResult>` as the in-flight first
   *      call (Promise-memoization), not initiate a second drain.
   *
   * Shutdown is TERMINAL for the host instance: after `shutdown()`
   * resolves, the host MUST refuse new `spawn()` calls (and consumers
   * MUST NOT re-use the instance — re-create a new host if a fresh
   * session is needed). Out-of-process backends MUST suppress
   * auto-respawn of the sidecar process triggered by the shutdown-
   * initiated child exit (the exit is deliberate, not a crash).
   *
   * Crash-budget interaction (`RustSidecarPtyHost` only): the
   * shutdown-driven sidecar exit MUST NOT consume the sliding-window
   * crash budget — `fireCrashTimeOnExit`'s `-1` sentinel emission MUST
   * be suppressed (the per-session `onExit` fires from the real
   * `ExitCodeNotification` arrivals during the drain) and
   * `recordCrashOncePerChild` MUST NOT be invoked for the
   * shutdown-initiated child exit.
   *
   * Consumer: Plan-001 §Cross-Plan Obligations CP-001-1
   * (`apps/desktop/src/main/sidecar-lifecycle.ts`) calls `shutdown()`
   * from the Electron `app.on('will-quit', ...)` handler that registers
   * before any other will-quit handler per Plan-024 §Invariants
   * I-024-4. The two timeouts are independent budgets so the wiring
   * layer can dimension each separately (per-session drain dominated
   * by child cleanup; host drain dominated by sidecar dispatcher
   * wind-down).
   */
  shutdown(options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult>;

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

/**
 * Result of a `PtyHost.shutdown()` drain cycle.
 *
 * Reported back to the lifecycle wiring layer (Plan-001 CP-001-1) so
 * the desktop main process can observe whether the will-quit handler
 * achieved a graceful drain or escalated to OS-level taskkill. The
 * fields are independent counters / flags — the four-value tuple
 * captures the per-session axis (drained vs. forced) and the
 * sidecar-process axis (clean exit vs. taskkill escalation)
 * separately.
 *
 * Invariants:
 *   - `sessionsDrained + sessionsForcedKilled` equals the count of
 *     sessions that were active at shutdown entry; sessions that had
 *     already exited before shutdown was called contribute to neither
 *     counter.
 *   - `sidecarExitedCleanly === false` implies `taskkillEscalated`
 *     may or may not be true (escalation is attempted but may itself
 *     fail; the flag records whether the daemon issued the
 *     `taskkill /T /F /PID` invocation). On `NodePtyHost`, both
 *     `sidecarExitedCleanly: true` and `taskkillEscalated: false`
 *     hold vacuously — there is no sidecar process to drain.
 */
export interface DrainResult {
  /**
   * Count of sessions that exited gracefully on `SIGTERM` within the
   * per-session timeout budget. Each such session emitted its real
   * `ExitCodeNotification` (or in-process `child.onExit` event) before
   * the timeout fired.
   */
  readonly sessionsDrained: number;
  /**
   * Count of sessions where the per-session timeout expired before the
   * graceful kill produced an exit notification, triggering escalation
   * to `SIGKILL` / `taskkill /T /F`. The session's `onExit` listener
   * still fires (either from the real exit notification arriving late
   * or from a synthetic emission per the SIGKILL escalation path), but
   * the drain was non-graceful.
   */
  readonly sessionsForcedKilled: number;
  /**
   * `true` iff the sidecar process exited within the host timeout
   * budget after the daemon closed its stdin. Vacuously `true` for
   * in-process backends with no sidecar (`NodePtyHost`). `false` means
   * the host-level timeout fired and the daemon either escalated to
   * `taskkill` (see `taskkillEscalated`) or gave up if the platform
   * has no equivalent escalation path.
   */
  readonly sidecarExitedCleanly: boolean;
  /**
   * `true` iff the daemon invoked `taskkill /T /F /PID <sidecar-pid>`
   * (Windows) or the platform-equivalent escalation against the
   * sidecar process. Vacuously `false` for in-process backends and for
   * out-of-process backends that exited cleanly within the host
   * timeout. The flag records the daemon-side action; whether the OS
   * reaping itself succeeded is opaque (the daemon must not block
   * indefinitely on a stuck OS-level kill).
   */
  readonly taskkillEscalated: boolean;
}
